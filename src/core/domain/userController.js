/**
 * User Controller - Production Ready
 * Handles user profile management and authentication
 * 
 * Features:
 * - User profile CRUD operations
 * - Multi-role support (customer, supplier, admin)
 * - Stripe customer integration
 * - Wishlist and likes management
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const { deleteCloudinaryImage, isValidCloudinaryUrl } = require('../services/cloudinaryHelper');
const { logActivity } = require('../services/auditLogger');
const { invalidateUserCache } = require('../../../middleware/authMiddleware');
const { getStripe, ensureStripeCustomer } = require('../services/stripeHelpers');
const redis = require('../services/redisClient');

const PM_CACHE_TTL = 30; // seconds — payment methods list cache

exports.getMe = catchAsync(async (req, res, next) => {
  if (!req.user) {
    return next(new AppError('User not found', 404));
  }

  // Never send the password hash to clients — they only need to know whether a
  // password exists (so social-login accounts can be offered "set password").
  const { passwordHash, ...safeUser } = req.user;

  // Optimize user photo
  const optimizedUser = {
    ...safeUser,
    hasPassword: Boolean(passwordHash),
    photoURL: req.user.photoURL
      ? req.user.photoURL
      : req.user.photoURL,
  };

  res.status(200).json({
    status: 'success',
    data: { user: optimizedUser },
  });
});

exports.updateMe = catchAsync(async (req, res, next) => {
  //  Block email updates
  if (req.body.email) {
    return next(new AppError('Email cannot be updated here', 400));
  }

  const updates = {};

  //  Text fields
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.phone !== undefined) updates.phone = req.body.phone;
  if (req.body.language !== undefined) updates.language = req.body.language;
  if (req.body.timezone !== undefined) updates.timezone = req.body.timezone;
  if (req.body.logoUrl !== undefined) updates.logoUrl = req.body.logoUrl;

  //  Location (account settings)
  if (req.body.address !== undefined) updates.address = req.body.address || null;
  if (req.body.city !== undefined) updates.city = req.body.city || null;
  if (req.body.state !== undefined) updates.state = req.body.state || null;
  if (req.body.zipCode !== undefined) updates.zipCode = req.body.zipCode || null;
  if (req.body.country !== undefined) updates.country = req.body.country || null;
  if (req.body.homeAirport !== undefined) updates.homeAirport = req.body.homeAirport || null;

  //  Date of birth — must be a real date, not in the future, and plausible.
  if (req.body.dateOfBirth !== undefined) {
    if (!req.body.dateOfBirth) {
      updates.dateOfBirth = null;
    } else {
      const dob = new Date(req.body.dateOfBirth);
      const now = new Date();
      const earliest = new Date('1900-01-01');
      if (isNaN(dob.getTime()) || dob > now || dob < earliest) {
        return next(new AppError('Invalid date of birth', 400));
      }
      updates.dateOfBirth = dob;
    }
  }

  if (req.file) {
    if (!isValidCloudinaryUrl(req.file.path)) {
      return next(new AppError('Upload failed: invalid image URL', 400));
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });

    if (user?.photoURL) {
      await deleteCloudinaryImage(user.photoURL, 3, { userId: req.user.id });
    }

    updates.photoURL = req.file.path;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(200).json({
      status: 'success',
      data: { user: req.user },
    });
  }

  const updatedUser = await prisma.user.update({
    where: { id: req.user.id },
    data: updates,
  });

  invalidateUserCache(req.user.id);

  // Log activity
  await logActivity({
    userId: req.user.id,
    action: 'user.profile_updated',
    resource: 'User',
    resourceId: req.user.id,
    oldValues: req.user,
    newValues: updatedUser
  });

  if (req.file?.path) {
    prisma.media.updateMany({
      where: { url: req.file.path },
      data: { status: 'ATTACHED', entity: 'user', entityId: updatedUser.id },
    }).catch(() => {});
  }

  res.status(200).json({ status: 'success', data: { user: updatedUser } });
});

exports.deleteMe = catchAsync(async (req, res) => {
  // Soft delete by setting active to false
  await prisma.user.update({
    where: { id: req.user.id },
    data: { active: false }
  });

  invalidateUserCache(req.user.id);

  // Log activity
  await logActivity({
    userId: req.user.id,
    action: 'user.account_deleted',
    resource: 'User',
    resourceId: req.user.id
  });

  res.status(204).json({
    status: 'success',
    data: null,
  });
});

exports.deleteUser = catchAsync(async (req, res, next) => {
  let user;
  try {
    user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { supplierProfile: { select: { id: true, status: true } } },
    });
    if (!user) {
      return next(new AppError('User not found', 404));
    }
    if (user.supplierProfile) {
      return next(new AppError(
        'Supplier accounts cannot be hard-deleted because it would destroy their tours, bookings, and history. Use POST /suppliers/admin/:id/archive to soft-delete the account instead.',
        409
      ));
    }
    await prisma.user.delete({ where: { id: req.params.id } });
  } catch {
    return next(new AppError('User not found', 404));
  }

  // Log activity
  await logActivity({
    userId: req.user.id,
    action: 'user.deleted_by_admin',
    resource: 'User',
    resourceId: req.params.id,
    oldValues: user ? {
      name: user.name,
      email: user.email,
      role: user.role,
      isVerified: user.isVerified,
    } : null,
  });

  res.status(204).json({ status: 'success', data: null });
});

// Wishlist tours are returned raw (not transformForListing-shaped) so the
// mini-site's listing mapper can render price, duration and location. These
// are the fields it reads; addedAt is merged per item from WishlistItem.
const WISHLIST_TOUR_SELECT = {
  id: true,
  title: true,
  slug: true,
  description: true,
  status: true,
  coverPhoto: true,
  photos: true,
  category: true,
  durationMinutes: true,
  averageRating: true,
  reviewCount: true,
  totalBookings: true,
  city: true,
  country: true,
  schedulesAndPricing: true,
  productContent: true,
  bookingAndTickets: true,
  supplier: {
    select: { id: true, name: true, photoURL: true }
  }
};

exports.getWishlist = catchAsync(async (req, res, next) => {
  const items = await prisma.wishlistItem.findMany({
    where: {
      userId: req.user.id,
      tour: { status: { not: 'DRAFT' } },
    },
    orderBy: { addedAt: 'desc' },
    include: { tour: { select: WISHLIST_TOUR_SELECT } },
  });

  const tours = items
    .filter((i) => i.tour)
    .map((i) => ({ ...i.tour, addedAt: i.addedAt }));

  res.status(200).json({
    status: 'success',
    results: tours.length,
    data: { tours }
  });
});

exports.addWishlist = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, status: { not: 'DRAFT' } },
    select: { id: true },
  });
  if (!tour) return next(new AppError('Tour not found', 404));

  const existing = await prisma.wishlistItem.findUnique({
    where: { userId_tourId: { userId: req.user.id, tourId } },
    select: { id: true },
  });
  if (!existing) {
    await prisma.wishlistItem.create({ data: { userId: req.user.id, tourId } });

    await logActivity({
      userId: req.user.id,
      action: 'user.wishlist_added',
      resource: 'User',
      resourceId: req.user.id,
      metadata: { tourId }
    });
  }

  res.status(200).json({
    status: 'success',
    data: { isWishlisted: true }
  });
});

exports.removeWishlist = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;

  const deleted = await prisma.wishlistItem.deleteMany({
    where: { userId: req.user.id, tourId },
  });
  if (deleted.count > 0) {
    await logActivity({
      userId: req.user.id,
      action: 'user.wishlist_removed',
      resource: 'User',
      resourceId: req.user.id,
      metadata: { tourId }
    });
  }

  res.status(200).json({
    status: 'success',
    data: { isWishlisted: false }
  });
});

exports.toggleWishlist = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, status: { not: 'DRAFT' } },
    select: { id: true },
  });
  if (!tour) return next(new AppError('Tour not found', 404));

  const existing = await prisma.wishlistItem.findUnique({
    where: { userId_tourId: { userId: req.user.id, tourId } },
    select: { id: true },
  });

  if (existing) {
    await prisma.wishlistItem.delete({ where: { id: existing.id } });

    await logActivity({
      userId: req.user.id,
      action: 'user.wishlist_removed',
      resource: 'User',
      resourceId: req.user.id,
      metadata: { tourId }
    });

    return res.status(200).json({
      status: 'success',
      data: { isWishlisted: false }
    });
  }

  await prisma.wishlistItem.create({ data: { userId: req.user.id, tourId } });

  await logActivity({
    userId: req.user.id,
    action: 'user.wishlist_added',
    resource: 'User',
    resourceId: req.user.id,
    metadata: { tourId }
  });

  res.status(200).json({
    status: 'success',
    data: { isWishlisted: true }
  });
});

exports.toggleLike = catchAsync(async (req, res, next) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return next(new AppError('User not found', 404));

  const tourId = req.params.tourId;
  const isLiked = user.likes.includes(tourId);
  const nextLikes = isLiked ? user.likes.filter((id) => id !== tourId) : [...user.likes, tourId];

  const updatedUser = await prisma.user.update({
    where: { id: req.user.id },
    data: { likes: nextLikes },
  });

  // Log activity
  await logActivity({
    userId: req.user.id,
    action: isLiked ? 'user.like_removed' : 'user.like_added',
    resource: 'User',
    resourceId: req.user.id,
    metadata: { tourId }
  });

  res.status(200).json({ status: 'success', data: { likes: updatedUser.likes } });
});

exports.createMe = catchAsync(async (req, res, next) => {
  // User already exists at this point (protect middleware ensures it)
  res.status(200).json({ status: 'success', data: { user: req.user } });
});

exports.syncMe = catchAsync(async (req, res) => {
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      lastLoginAt: new Date(),
    },
  });

  await logActivity({
    userId: user.id,
    action: 'user.synced',
    resource: 'User',
    resourceId: user.id,
  });

  res.status(200).json({ status: 'success', data: { user } });
});

// ─── Saved cards (Stripe payment methods) ───────────────────────────────
//
// Cards are stored on the Stripe Customer (never in our DB). These endpoints
// expose the customer's own saved cards for the Account Settings page. Card
// details never touch our servers — Stripe Elements collects them client-side.

/** Resolve the caller's Stripe customer, failing loudly if it can't be created.
 *  Self-heals stale stripeCustomerId values (e.g. customer deleted in Stripe).
 *
 *  NOTE: We no longer call customers.retrieve() eagerly here — that added
 * 200-500ms on every card endpoint. Instead, downstream Stripe calls will
 * surface `resource_missing` if the customer is gone, and callers can use
 * healStaleCustomer() to recover. */
async function requireCustomer(user) {
  const customerId = await ensureStripeCustomer(user);
  if (!customerId) {
    throw new AppError('Could not initialize your billing profile. Please try again.', 502);
  }
  return customerId;
}

/** Repair a stale Stripe customer mapping: clear the stored ID, create a
 *  fresh customer, and return the new ID. Throws on failure. */
async function healStaleCustomer(user, err) {
  if (!err || err.code !== 'resource_missing') throw err;
  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: null },
  });
  invalidateUserCache(user.id);
  const freshId = await ensureStripeCustomer({ ...user, stripeCustomerId: null });
  if (!freshId) {
    throw new AppError('Could not initialize your billing profile. Please try again.', 502);
  }
  return freshId;
}

/** Shape a Stripe PaymentMethod into the fields the UI needs. */
function toSavedCard(pm, defaultPaymentMethodId) {
  const card = pm.card || {};
  const now = new Date();
  const expired =
    card.exp_year != null &&
    (card.exp_year < now.getFullYear() ||
      (card.exp_year === now.getFullYear() && card.exp_month < now.getMonth() + 1));

  return {
    id: pm.id,
    brand: card.brand || 'card',
    last4: card.last4 || '****',
    expMonth: card.exp_month ?? null,
    expYear: card.exp_year ?? null,
    expired,
    isDefault: pm.id === defaultPaymentMethodId,
  };
}

/**
 * GET /api/users/payment-methods
 * Lists the authenticated customer's saved cards.
 *
 * Results are cached in Redis for PM_CACHE_TTL seconds to avoid hitting
 * Stripe on every page load / tab switch.
 */
exports.listPaymentMethods = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const cacheKey = `pm:list:${userId}`;

  // ── Serve from cache if available ────────────────────────────────────
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.status(200).json({ status: 'success', data: { cards: cached } });
  }

  // ── Cache miss — fetch from Stripe ───────────────────────────────────
  let customerId = await requireCustomer(req.user);
  const stripe = getStripe();

  let methods, customer;
  try {
    [methods, customer] = await Promise.all([
      stripe.paymentMethods.list({ customer: customerId, type: 'card' }),
      stripe.customers.retrieve(customerId),
    ]);
  } catch (err) {
    // Self-heal: if the stored customer was deleted in Stripe, retry once.
    if (err.code === 'resource_missing') {
      customerId = await healStaleCustomer(req.user, err);
      [methods, customer] = await Promise.all([
        stripe.paymentMethods.list({ customer: customerId, type: 'card' }),
        stripe.customers.retrieve(customerId),
      ]);
    } else {
      throw err;
    }
  }

  const defaultPmId = customer?.invoice_settings?.default_payment_method || null;

  // Self-heal: cards saved before allow_redisplay was set are attached but
  // invisible to the Payment Element. Upgrade them so they can be offered
  // again at checkout.
  const needsUpgrade = (methods.data || []).filter(
    (pm) => pm.allow_redisplay && pm.allow_redisplay !== 'always'
  );
  if (needsUpgrade.length) {
    await Promise.all(
      needsUpgrade.map((pm) =>
        stripe.paymentMethods
          .update(pm.id, { allow_redisplay: 'always' })
          .catch((err) => console.warn(`[Stripe] Could not upgrade allow_redisplay for ${pm.id}:`, err.message))
      )
    );
  }

  const cards = (methods.data || []).map((pm) => toSavedCard(pm, defaultPmId));

  // Surface the default first, then most-recently-usable.
  cards.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

  // ── Populate cache ───────────────────────────────────────────────────
  await redis.set(cacheKey, cards, PM_CACHE_TTL);

  res.status(200).json({ status: 'success', data: { cards } });
});

/**
 * POST /api/users/payment-methods/setup-intent
 * Creates a SetupIntent so the client can collect + save a card.
 */
exports.createSetupIntent = catchAsync(async (req, res) => {
  let customerId = await requireCustomer(req.user);
  const stripe = getStripe();

  let intent;
  try {
    intent = await stripe.setupIntents.create({
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      metadata: { userId: req.user.id },
    });
  } catch (err) {
    if (err.code === 'resource_missing') {
      customerId = await healStaleCustomer(req.user, err);
      intent = await stripe.setupIntents.create({
        customer: customerId,
        automatic_payment_methods: { enabled: true },
        metadata: { userId: req.user.id },
      });
    } else {
      throw err;
    }
  }

  res.status(200).json({
    status: 'success',
    data: { clientSecret: intent.client_secret },
  });
});

/**
 * PATCH /api/users/payment-methods/:id/default
 * Marks a saved card as the customer's default.
 */
exports.setDefaultPaymentMethod = catchAsync(async (req, res, next) => {
  let customerId = await requireCustomer(req.user);
  const stripe = getStripe();

  // Ownership check — the card must belong to this customer.
  let pm;
  try {
    pm = await stripe.paymentMethods.retrieve(req.params.id);
  } catch (err) {
    if (err.code === 'resource_missing') return next(new AppError('Card not found', 404));
    throw err;
  }
  if (pm.customer !== customerId) return next(new AppError('Card not found', 404));

  try {
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: pm.id },
    });
  } catch (err) {
    if (err.code === 'resource_missing') {
      customerId = await healStaleCustomer(req.user, err);
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: pm.id },
      });
    } else {
      throw err;
    }
  }

  await redis.del(`pm:list:${req.user.id}`).catch(() => {});
  res.status(200).json({ status: 'success', data: { id: pm.id } });
});

/**
 * DELETE /api/users/payment-methods/:id
 * Detaches a saved card from the customer.
 */
exports.detachPaymentMethod = catchAsync(async (req, res, next) => {
  let customerId = await requireCustomer(req.user);
  const stripe = getStripe();

  let pm;
  try {
    pm = await stripe.paymentMethods.retrieve(req.params.id);
  } catch (err) {
    if (err.code === 'resource_missing') return next(new AppError('Card not found', 404));
    throw err;
  }
  if (pm.customer !== customerId) return next(new AppError('Card not found', 404));

  await stripe.paymentMethods.detach(pm.id);

  await redis.del(`pm:list:${req.user.id}`).catch(() => {});
  await logActivity({
    userId: req.user.id,
    action: 'user.payment_method_removed',
    resource: 'User',
    resourceId: req.user.id,
    metadata: { brand: pm.card?.brand, last4: pm.card?.last4 },
  });

  res.status(200).json({ status: 'success' });
});

module.exports = exports;
