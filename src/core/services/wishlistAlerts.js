/**
 * Wishlist price alerts.
 *
 * A saved experience is compared against the price the traveller saw when they
 * saved it (`WishlistItem.priceAtSave`, written server-side at save time from
 * the same cheapestRetailPrice() the listing cards quote). An alert fires only
 * when the current price is at least `MIN_DROP_PERCENT` below the baseline,
 * and never more than once per `COOLDOWN_DAYS` per item.
 *
 * After a successful alert the baseline moves to the new price. That keeps the
 * meaning honest — the next alert is another real drop — and it stops a tour
 * that simply sits cheaper from re-mailing the same saving every day.
 *
 * Rows saved before the baseline column shipped have `priceAtSave = NULL` and
 * are never alerted on: there is nothing to measure a drop against.
 */

const { isEnabled } = require('./featureFlags');

const BATCH_LIMIT = 200;
const MIN_DROP_PERCENT = 5;
const COOLDOWN_DAYS = 30;

async function checkWishlistPriceDrops({ batchLimit = BATCH_LIMIT } = {}) {
  if (!isEnabled('priceAlerts')) return { scanned: 0, sent: 0, skipped: 0, disabled: true };

  const prisma = require('./prismaClient');
  const { cheapestRetailPrice } = require('./tourHelpers');
  const { sendWishlistPriceDropEmail } = require('./emailService');
  const { sendNotification } = require('./notificationService');

  const cooldownCutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 3600 * 1000);
  const items = await prisma.wishlistItem.findMany({
    where: {
      priceAtSave: { not: null },
      OR: [{ lastPriceAlertAt: null }, { lastPriceAlertAt: { lt: cooldownCutoff } }],
      // Give a freshly saved item time to settle: never alert on the price
      // the traveller just saved minutes ago.
      addedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) },
    },
    orderBy: { addedAt: 'asc' },
    take: batchLimit,
    include: {
      tour: {
        select: {
          id: true,
          slug: true,
          title: true,
          city: true,
          country: true,
          coverPhoto: true,
          photos: true,
          status: true,
          schedulesAndPricing: true,
        },
      },
      user: { select: { id: true, name: true, email: true } },
    },
  });

  let sent = 0;
  let skipped = 0;

  for (const item of items) {
    const tour = item.tour;
    // A purged or unpublished tour is gone from the catalogue: drop the alert
    // silently rather than emailing a dead link.
    if (!tour || tour.status !== 'ACTIVE') {
      skipped += 1;
      continue;
    }

    let currentPrice = null;
    try {
      currentPrice = cheapestRetailPrice(tour.schedulesAndPricing);
    } catch {
      skipped += 1;
      continue;
    }
    if (currentPrice == null) {
      skipped += 1;
      continue;
    }

    const baseline = Number(item.priceAtSave);
    const drop = baseline > 0 ? ((baseline - currentPrice) / baseline) * 100 : 0;
    if (drop < MIN_DROP_PERCENT) {
      // Price went up or stayed put. Leave the baseline alone so a later fall
      // is still measured against what they saved it at.
      skipped += 1;
      continue;
    }

    // Claim before sending: `lastPriceAlertAt` is the idempotency key.
    const claimed = await prisma.wishlistItem.updateMany({
      where: { id: item.id, lastPriceAlertAt: item.lastPriceAlertAt },
      data: { lastPriceAlertAt: new Date(), priceAtSave: currentPrice },
    });
    if (claimed.count === 0) {
      skipped += 1;
      continue;
    }

    const currency = item.currency || 'USD';
    try {
      await sendWishlistPriceDropEmail({
        userId: item.userId,
        tour,
        oldPrice: baseline,
        newPrice: Number(currentPrice),
        currency,
      });
      await sendNotification({
        userId: item.userId,
        type: 'PRICE_DROP',
        title: `${tour.title} dropped in price`,
        message: `It is now ${currency} ${Number(currentPrice).toFixed(2)}, down from ${currency} ${baseline.toFixed(2)}.`,
        data: { tourId: tour.id, slug: tour.slug, oldPrice: baseline, newPrice: Number(currentPrice), currency },
        sendEmail: false,
        dedupeKey: `price-drop:${item.id}:${new Date().toISOString().slice(0, 10)}`,
      });
      sent += 1;
      console.log(`[WishlistAlerts] drop ${baseline} → ${currentPrice} for ${tour.id} → ${item.user?.email || item.userId}`);
    } catch (err) {
      skipped += 1;
      console.error(`[WishlistAlerts] failed for item ${item.id}:`, err.message);
    }
  }

  return { scanned: items.length, sent, skipped };
}

module.exports = { checkWishlistPriceDrops, BATCH_LIMIT, MIN_DROP_PERCENT, COOLDOWN_DAYS };
