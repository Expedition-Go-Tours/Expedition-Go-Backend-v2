/**
 * Funnel engine — computes the booking conversion funnel for a brand scope.
 *
 * The funnel IS the real user journey on the live storefronts:
 *
 *   Tour Viewed → Checkout Started → Booking Completed
 *
 * There is NO cart step. Travio Ghana, Travio Africa and Expedition all route
 * Tour → Booking → (hold-based) Checkout — the legacy server cart
 * (`cart.added` / `booking.initiated`) is retired and its admin surfaces were
 * removed. The funnel deliberately ships no cart stage so it never reports
 * phantom drop-offs on a step that cannot happen.
 *
 * Each step is a DISTINCT-PERSON count, not an event count:
 *   - Tour Viewed       ← Event table, `tour.viewed` / `<brand>.tour_viewed`.
 *                         These events are written synchronously via
 *                         eventEmitter (they reliably land) and this is the
 *                         only step that still reads events.
 *   - Checkout Started  ← CheckoutDraft rows. Every seat-hold acquire IS the
 *                         checkout start, so the hold table is the ground
 *                         truth — immune to fire-and-forget analytics drops
 *                         (a past outage silently ate every queued event).
 *   - Booking Completed ← Booking rows (`isSimulated = false`, not CANCELLED).
 *                         A created booking is a completed checkout; pay-later
 *                         reservations count (they reserved successfully),
 *                         cancelled bookings do not.
 *
 * Brand scoping mirrors the rest of the Ghana/Africa dashboards
 * (`brandBookingWhere`): a draft/booking belongs to a brand when its source is
 * the brand's OR its tour's supplier carries the brand role. Views are scoped
 * by the event's stamped `properties.source` (eventBrand.js aliases expedition
 * → ghana, so Expedition storefront traffic rolls up under Ghana). Passing
 * `brand: null` (core /api/admin/analytics/funnel) disables brand filtering.
 *
 * The result also carries the "insights" block used by the admin funnel page:
 * the biggest step-pair drop-off, the median pay-now checkout time
 * (draft created → booking materialized) and abandoned-checkout value
 * (EXPIRED holds plus their frozen totals) with the top tours by value.
 */

const { Prisma } = require('@prisma/client');
const prisma = require('./prismaClient');

const sql = Prisma.sql;

/** Frozen checkout total from a draft's pricing blob, NULL-safe. */
const safeTotal = sql`COALESCE(NULLIF(d."pricing"->>'total', '')::numeric, 0)`;

const calcRate = (numerator, denominator) =>
  denominator > 0 ? parseFloat(((numerator / denominator) * 100).toFixed(1)) : 0;

/** Normalize a `::date` value (ISO string from Postgres, or Date in tests) to YYYY-MM-DD. */
const toDayKey = (value) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

/**
 * Compute the conversion funnel.
 *
 * @param {Object}   opts
 * @param {Date}     opts.startDate — window start (inclusive); now is the end
 * @param {Object}   [opts.brand]   — { key, source, role } scoping.
 *                                   null/undefined = platform-wide (core route)
 */
async function computeFunnel({ startDate, brand = null }) {
  const scoped = !!brand && !!brand.source && !!brand.role;

  // Event name + brand filter for the "Tour Viewed" step.
  const viewNames = scoped
    ? sql`e."name" IN ('tour.viewed', ${`${brand.key}.tour_viewed`})`
    : sql`(e."name" = 'tour.viewed' OR e."name" LIKE '%.tour_viewed')`;
  const viewBrand = scoped ? sql`AND e."properties"->>'source' = ${brand.key}` : Prisma.empty;

  // Brand pipeline scope (CheckoutDraft d / Booking b join Tour t + User u):
  // source matches the brand, or the tour's supplier carries the brand role.
  const draftScope = scoped
    ? sql`AND (d."payload"->>'_source' = ${brand.source} OR ${brand.role} = ANY(u."roles"::text[]))`
    : Prisma.empty;
  const bookingScope = scoped
    ? sql`AND (b."source"::text = ${brand.source} OR ${brand.role} = ANY(u."roles"::text[]))`
    : Prisma.empty;
  const draftJoins = sql`"CheckoutDraft" d
    JOIN "Tour" t ON t.id = d."tourId"
    JOIN "User" u ON u.id = t."supplierId"`;
  const bookingJoins = sql`"Booking" b
    JOIN "Tour" t ON t.id = b."tourId"
    JOIN "User" u ON u.id = t."supplierId"`;

  const [
    stepRows,
    viewDays,
    checkoutDays,
    bookingDays,
    medianRows,
    abandonedRows,
    byTourRows,
  ] = await Promise.all([
    // 1. Distinct people per step.
    prisma.$queryRaw`
      SELECT step, COUNT(DISTINCT identity)::int AS users
      FROM (
        SELECT 'viewed' AS step, COALESCE(e."userId", e."sessionId") AS identity
        FROM "Event" e
        WHERE ${viewNames} AND e."createdAt" >= ${startDate} ${viewBrand}
        UNION ALL
        SELECT 'checkout_started', d."customerId"
        FROM ${draftJoins}
        WHERE d."createdAt" >= ${startDate} ${draftScope}
        UNION ALL
        SELECT 'booking_completed', b."customerId"
        FROM ${bookingJoins}
        WHERE b."createdAt" >= ${startDate}
          AND b."isSimulated" = false
          AND b."status" <> 'CANCELLED'
          ${bookingScope}
      ) s
      WHERE identity IS NOT NULL
      GROUP BY step
    `,

    // 2. Daily distinct viewers.
    prisma.$queryRaw`
      SELECT DATE_TRUNC('day', e."createdAt")::date AS day,
             COUNT(DISTINCT COALESCE(e."userId", e."sessionId"))::int AS users
      FROM "Event" e
      WHERE ${viewNames} AND e."createdAt" >= ${startDate} ${viewBrand}
      GROUP BY 1
    `,

    // 3. Daily distinct checkout starters.
    prisma.$queryRaw`
      SELECT DATE_TRUNC('day', d."createdAt")::date AS day,
             COUNT(DISTINCT d."customerId")::int AS users
      FROM ${draftJoins}
      WHERE d."createdAt" >= ${startDate} ${draftScope}
      GROUP BY 1
    `,

    // 4. Daily distinct booking completions.
    prisma.$queryRaw`
      SELECT DATE_TRUNC('day', b."createdAt")::date AS day,
             COUNT(DISTINCT b."customerId")::int AS users
      FROM ${bookingJoins}
      WHERE b."createdAt" >= ${startDate}
        AND b."isSimulated" = false
        AND b."status" <> 'CANCELLED'
        ${bookingScope}
      GROUP BY 1
    `,

    // 5. Median pay-now checkout time: hold created → booking materialized.
    prisma.$queryRaw`
      SELECT ROUND(
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (b."createdAt" - d."createdAt")) / 60
        )::numeric, 0
      )::float AS median_minutes
      FROM ${draftJoins}
      JOIN "Booking" b ON b.id = d."bookingId"
      WHERE d."status" = 'PAID' AND d."bookingId" IS NOT NULL
        AND d."createdAt" >= ${startDate}
        ${draftScope}
    `,

    // 6. Abandoned checkouts: EXPIRED holds + frozen total value.
    prisma.$queryRaw`
      SELECT COUNT(DISTINCT d."customerId")::int AS checkouts,
             ROUND(COALESCE(SUM(${safeTotal}), 0), 2)::float AS value
      FROM ${draftJoins}
      WHERE d."status" = 'EXPIRED' AND d."createdAt" >= ${startDate}
        ${draftScope}
    `,

    // 7. Abandoned checkouts by tour (recoverable value).
    prisma.$queryRaw`
      SELECT d."tourId" AS "tourId",
             t.title AS "tourTitle",
             COUNT(DISTINCT d."customerId")::int AS checkouts,
             ROUND(COALESCE(SUM(${safeTotal}), 0), 2)::float AS value
      FROM ${draftJoins}
      WHERE d."status" = 'EXPIRED' AND d."createdAt" >= ${startDate}
        ${draftScope}
      GROUP BY d."tourId", t.title
      ORDER BY value DESC
      LIMIT 8
    `,
  ]);

  const usersFor = (step) => Number(stepRows.find((r) => r.step === step)?.users || 0);
  const viewedUsers = usersFor('viewed');
  const checkoutUsers = usersFor('checkout_started');
  const completedUsers = usersFor('booking_completed');

  const viewToCheckout = calcRate(checkoutUsers, viewedUsers);
  const checkoutToBook = calcRate(completedUsers, checkoutUsers);
  const overall = calcRate(completedUsers, viewedUsers);

  const funnel = [
    {
      step: 'viewed',
      users: viewedUsers,
      overallPct: viewedUsers > 0 ? 100 : 0,
      relativePct: null,
      dropOff: null,
    },
    {
      step: 'checkout_started',
      users: checkoutUsers,
      overallPct: viewToCheckout,
      relativePct: viewToCheckout,
      dropOff: `${(100 - viewToCheckout).toFixed(1)}%`,
    },
    {
      step: 'booking_completed',
      users: completedUsers,
      overallPct: overall,
      relativePct: checkoutToBook,
      dropOff: `${(100 - checkoutToBook).toFixed(1)}%`,
    },
  ];

  // Biggest absolute leak between two steps (the "fix this first" takeaway).
  const dropViewed = viewedUsers - checkoutUsers;
  const dropCheckout = checkoutUsers - completedUsers;
  const biggestDropOff =
    dropViewed >= dropCheckout
      ? { from: 'viewed', to: 'checkout_started', users: Math.max(dropViewed, 0), rate: 100 - viewToCheckout }
      : { from: 'checkout_started', to: 'booking_completed', users: Math.max(dropCheckout, 0), rate: 100 - checkoutToBook };

  // Merge the three per-day series into one sorted array.
  const trend = new Map();
  for (const r of viewDays) {
    const key = toDayKey(r.day);
    trend.set(key, { day: key, views: Number(r.users || 0), checkouts: 0, bookings: 0 });
  }
  for (const r of checkoutDays) {
    const key = toDayKey(r.day);
    const entry = trend.get(key) || { day: key, views: 0, checkouts: 0, bookings: 0 };
    entry.checkouts = Number(r.users || 0);
    trend.set(key, entry);
  }
  for (const r of bookingDays) {
    const key = toDayKey(r.day);
    const entry = trend.get(key) || { day: key, views: 0, checkouts: 0, bookings: 0 };
    entry.bookings = Number(r.users || 0);
    trend.set(key, entry);
  }
  const dailyTrend = Array.from(trend.values()).sort((a, b) => String(a.day).localeCompare(String(b.day)));

  return {
    funnel,
    conversionRates: { viewToCheckout, checkoutToBook, overall },
    dailyTrend,
    insights: {
      biggestDropOff: {
        from: biggestDropOff.from,
        to: biggestDropOff.to,
        users: biggestDropOff.users,
        rate: biggestDropOff.rate,
      },
      medianTimeToBookMinutes: Number(medianRows[0]?.median_minutes || 0),
      abandoned: {
        checkouts: Number(abandonedRows[0]?.checkouts || 0),
        value: Number(abandonedRows[0]?.value || 0),
        byTour: byTourRows.map((r) => ({
          tourId: r.tourId,
          tourTitle: r.tourTitle || 'Unknown',
          checkouts: Number(r.checkouts || 0),
          value: Number(r.value || 0),
        })),
      },
    },
  };
}

module.exports = { computeFunnel };