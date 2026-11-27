/**
 * Owner photo library.
 *
 * `RestaurantVenue.photos` is the projection the storefront reads, and it stays
 * that way: nothing in the public read path knows this table exists. Every
 * status or order change runs `syncPublishedPhotos`, which rewrites the
 * projection from the PUBLISHED rows in gallery order. That keeps one source of
 * truth and means a rejected photo disappears from the listing without a
 * second code path.
 *
 * Owner uploads are moderated, so a new row starts PENDING and is invisible to
 * diners until an admin publishes it.
 */

const prisma = require('./prismaClient');
const AppError = require('./appError');
const cache = require('./cacheHelper');
const logger = require('./logger');
const { enqueueEvent } = require('./queue');
const { logActivity } = require('./auditLogger');
const { notifyAdmin } = require('./adminNotificationService');
const { isValidCloudinaryUrl } = require('./cloudinaryHelper');
const { assertPermission } = require('./restaurantVenueAccess');

const MAX_PHOTOS = 40;
const MAX_PER_UPLOAD = 10;
const MAX_CAPTION = 200;

function invalidate(venue) {
  cache
    .invalidateRestaurantVenueCaches(venue.id, venue.slug)
    .catch((err) => logger.warn('[cache] restaurant venue invalidation failed:', err?.message));
}

function toPhoto(row) {
  return {
    id: row.id,
    url: row.url,
    caption: row.caption ?? null,
    position: row.position,
    status: row.status,
    source: row.source,
    createdAt: row.createdAt,
    moderatedAt: row.moderatedAt ?? null,
    flagReason: row.flagReason ?? null,
  };
}

/**
 * Rewrite the public projection from the published rows.
 *
 * Order is the gallery order, so dragging a photo in the dashboard is the same
 * operation as changing the storefront gallery. The cover is kept when it is
 * still published; otherwise it falls back to the first published photo.
 */
async function syncPublishedPhotos(tx, venueId) {
  const [published, venue] = await Promise.all([
    tx.restaurantVenuePhoto.findMany({
      where: { venueId, status: 'PUBLISHED' },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { url: true },
    }),
    tx.restaurantVenue.findUnique({
      where: { id: venueId },
      select: { coverPhoto: true },
    }),
  ]);

  const urls = published.map((row) => row.url);
  const coverPhoto =
    venue && venue.coverPhoto && urls.includes(venue.coverPhoto)
      ? venue.coverPhoto
      : urls[0] || null;

  await tx.restaurantVenue.update({
    where: { id: venueId },
    data: { photos: urls, coverPhoto },
  });

  return { photos: urls, coverPhoto };
}

async function listPhotos(context) {
  assertPermission(context, 'photos.manage');
  const venueId = context.venue.id;

  const [rows, counts] = await Promise.all([
    prisma.restaurantVenuePhoto.findMany({
      where: { venueId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.restaurantVenuePhoto.groupBy({
      by: ['status'],
      where: { venueId },
      _count: { _all: true },
    }),
  ]);

  const byStatus = counts.reduce((acc, row) => {
    acc[row.status] = row._count._all;
    return acc;
  }, {});

  return {
    photos: rows.map(toPhoto),
    counts: {
      total: rows.length,
      published: byStatus.PUBLISHED || 0,
      pending: byStatus.PENDING || 0,
      rejected: byStatus.REJECTED || 0,
    },
    coverPhoto: context.venue.coverPhoto,
    limit: MAX_PHOTOS,
  };
}

async function addPhotos(context, { urls, caption }, req) {
  assertPermission(context, 'photos.manage');
  const venueId = context.venue.id;

  if (!Array.isArray(urls) || urls.length === 0) {
    throw new AppError('Upload at least one photo', 400, { code: 'NO_PHOTOS_UPLOADED' });
  }
  if (urls.length > MAX_PER_UPLOAD) {
    throw new AppError(`Upload at most ${MAX_PER_UPLOAD} photos at a time`, 400, {
      code: 'TOO_MANY_PHOTOS',
      details: { max: MAX_PER_UPLOAD },
    });
  }

  const clean = [...new Set(urls.map((url) => String(url).trim()).filter(Boolean))];
  if (clean.some((url) => !isValidCloudinaryUrl(url))) {
    throw new AppError('Photos must be uploaded to Travio first', 400, {
      code: 'INVALID_IMAGE_URL',
    });
  }

  const existing = await prisma.restaurantVenuePhoto.count({ where: { venueId } });
  if (existing + clean.length > MAX_PHOTOS) {
    throw new AppError(`A listing can hold at most ${MAX_PHOTOS} photos`, 400, {
      code: 'PHOTO_LIMIT_REACHED',
      details: { max: MAX_PHOTOS, current: existing },
    });
  }

  const cleanCaption =
    caption === undefined || caption === null
      ? null
      : String(caption).trim().slice(0, MAX_CAPTION) || null;

  const last = await prisma.restaurantVenuePhoto.findFirst({
    where: { venueId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  const start = (last ? last.position : 0) + 1;

  const created = await prisma.$transaction(async (tx) => {
    const rows = [];
    for (let index = 0; index < clean.length; index += 1) {
      // `upsert` on (venueId, url): re-uploading a rejected photo should put it
      // back in the queue rather than 409 on a unique constraint.
      rows.push(
        await tx.restaurantVenuePhoto.upsert({
          where: { venueId_url: { venueId, url: clean[index] } },
          create: {
            venueId,
            url: clean[index],
            caption: cleanCaption,
            position: start + index,
            status: 'PENDING',
            source: 'OWNER',
            uploadedById: context.membership.userId,
          },
          update: {
            status: 'PENDING',
            flagReason: null,
            moderatedBy: null,
            moderatedAt: null,
            ...(cleanCaption ? { caption: cleanCaption } : {}),
          },
        }),
      );
    }
    return rows;
  });

  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantVenuePhoto.uploaded',
    resource: 'RestaurantVenue',
    resourceId: venueId,
    metadata: { venueId, photoIds: created.map((row) => row.id), count: created.length },
  });
  enqueueEvent({
    name: 'restaurant_venue_photo.uploaded',
    userId: context.membership.userId,
    req,
    resource: 'RestaurantVenue',
    resourceId: venueId,
    properties: { venueId, count: created.length },
  });
  notifyAdmin({
    type: 'RESTAURANT_PHOTOS_NEED_MODERATION',
    title: 'Restaurant photos need moderation',
    message: `${created.length} photo${created.length === 1 ? '' : 's'} for ${context.venue.name} waiting for approval.`,
    data: { venueId, photoIds: created.map((row) => row.id) },
  }).catch((err) => logger.warn('[admin] photo notification failed:', err?.message));

  return { photos: created.map(toPhoto) };
}

async function updatePhoto(context, { photoId, caption, position }) {
  assertPermission(context, 'photos.manage');
  const venueId = context.venue.id;

  const photo = await prisma.restaurantVenuePhoto.findFirst({
    where: { id: photoId, venueId },
    select: { id: true, position: true, status: true },
  });
  if (!photo) throw new AppError('Photo not found', 404, { code: 'PHOTO_NOT_FOUND' });

  const data = {};
  if (caption !== undefined) {
    data.caption =
      caption === null ? null : String(caption).trim().slice(0, MAX_CAPTION) || null;
  }
  if (position !== undefined) {
    const next = Number(position);
    if (!Number.isInteger(next) || next < 0) {
      throw new AppError('Position must be a whole number', 400, {
        code: 'INVALID_POSITION',
      });
    }
    data.position = next;
  }
  if (Object.keys(data).length === 0) {
    throw new AppError('Nothing to update', 400, { code: 'EMPTY_UPDATE' });
  }

  const updated = await prisma.restaurantVenuePhoto.update({
    where: { id: photo.id },
    data,
  });

  if (data.position !== undefined && photo.status === 'PUBLISHED') {
    await prisma.$transaction((tx) => syncPublishedPhotos(tx, venueId));
    invalidate(context.venue);
  }

  return toPhoto(updated);
}

async function reorderPhotos(context, { photoIds }) {
  assertPermission(context, 'photos.manage');
  const venueId = context.venue.id;

  if (!Array.isArray(photoIds) || photoIds.length === 0) {
    throw new AppError('Send the photo order', 400, { code: 'INVALID_ORDER' });
  }

  const rows = await prisma.restaurantVenuePhoto.findMany({
    where: { venueId },
    select: { id: true },
  });
  const known = new Set(rows.map((row) => row.id));
  const sent = new Set(photoIds.map(String));
  if (sent.size !== photoIds.length || sent.size !== known.size) {
    throw new AppError('The order must list every photo exactly once', 400, {
      code: 'INCOMPLETE_ORDER',
    });
  }
  for (const id of sent) {
    if (!known.has(id)) {
      throw new AppError('The order contains an unknown photo', 400, {
        code: 'UNKNOWN_PHOTO',
      });
    }
  }

  const { photos, coverPhoto } = await prisma.$transaction(async (tx) => {
    for (let index = 0; index < photoIds.length; index += 1) {
      await tx.restaurantVenuePhoto.update({
        where: { id: String(photoIds[index]) },
        data: { position: index },
      });
    }
    return syncPublishedPhotos(tx, venueId);
  });

  invalidate(context.venue);
  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantVenuePhoto.reordered',
    resource: 'RestaurantVenue',
    resourceId: venueId,
    metadata: { venueId, count: photoIds.length },
  });

  return { photos, coverPhoto };
}

async function setCoverPhoto(context, { photoId }) {
  assertPermission(context, 'photos.manage');
  const venueId = context.venue.id;

  const photo = await prisma.restaurantVenuePhoto.findFirst({
    where: { id: photoId, venueId },
    select: { id: true, url: true, status: true },
  });
  if (!photo) throw new AppError('Photo not found', 404, { code: 'PHOTO_NOT_FOUND' });
  if (photo.status !== 'PUBLISHED') {
    throw new AppError('A photo must be published before it can be the cover', 409, {
      code: 'PHOTO_NOT_PUBLISHED',
    });
  }

  await prisma.restaurantVenue.update({
    where: { id: venueId },
    data: { coverPhoto: photo.url },
  });
  invalidate(context.venue);

  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantVenuePhoto.coverSet',
    resource: 'RestaurantVenue',
    resourceId: venueId,
    metadata: { venueId, photoId: photo.id },
  });

  return { coverPhoto: photo.url };
}

async function deletePhoto(context, { photoId }) {
  assertPermission(context, 'photos.manage');
  const venueId = context.venue.id;

  const photo = await prisma.restaurantVenuePhoto.findFirst({
    where: { id: photoId, venueId },
    select: { id: true, status: true },
  });
  if (!photo) throw new AppError('Photo not found', 404, { code: 'PHOTO_NOT_FOUND' });

  const projection = await prisma.$transaction(async (tx) => {
    await tx.restaurantVenuePhoto.delete({ where: { id: photo.id } });
    return syncPublishedPhotos(tx, venueId);
  });

  invalidate(context.venue);
  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantVenuePhoto.deleted',
    resource: 'RestaurantVenue',
    resourceId: venueId,
    metadata: { venueId, photoId: photo.id, previousStatus: photo.status },
  });

  return { id: photo.id, ...projection };
}

/** Admin moderation of one owner photo. */
async function moderatePhoto({ photoId, adminId, action, reason, req }) {
  const statuses = { publish: 'PUBLISHED', reject: 'REJECTED' };
  const nextStatus = statuses[action];
  if (!nextStatus) {
    throw new AppError('Invalid moderation action', 400, {
      code: 'INVALID_MODERATION_ACTION',
    });
  }

  const photo = await prisma.restaurantVenuePhoto.findUnique({
    where: { id: photoId },
    include: { venue: { select: { id: true, slug: true, name: true } } },
  });
  if (!photo) throw new AppError('Photo not found', 404, { code: 'PHOTO_NOT_FOUND' });

  const projection = await prisma.$transaction(async (tx) => {
    await tx.restaurantVenuePhoto.update({
      where: { id: photo.id },
      data: {
        status: nextStatus,
        moderatedBy: adminId,
        moderatedAt: new Date(),
        flagReason: action === 'reject' ? reason || 'rejected' : null,
      },
    });
    return syncPublishedPhotos(tx, photo.venueId);
  });

  invalidate(photo.venue);
  await logActivity({
    userId: adminId,
    action: `restaurantVenuePhoto.${action}`,
    resource: 'RestaurantVenue',
    resourceId: photo.venueId,
    metadata: { venueId: photo.venueId, photoId: photo.id, reason: reason || null },
  });
  enqueueEvent({
    name: `restaurant_venue_photo.${action}`,
    userId: adminId,
    req,
    resource: 'RestaurantVenue',
    resourceId: photo.venueId,
    properties: { venueId: photo.venueId, photoId: photo.id },
  });

  return { photo: toPhoto({ ...photo, status: nextStatus }), ...projection };
}

async function listPendingPhotos({ limit = 40 } = {}) {
  const rows = await prisma.restaurantVenuePhoto.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: { venue: { select: { name: true, slug: true } } },
  });
  return {
    photos: rows.map((row) => ({
      ...toPhoto(row),
      venueName: row.venue ? row.venue.name : null,
      venueSlug: row.venue ? row.venue.slug : null,
    })),
  };
}

module.exports = {
  MAX_PHOTOS,
  MAX_PER_UPLOAD,
  MAX_CAPTION,
  syncPublishedPhotos,
  listPhotos,
  addPhotos,
  updatePhoto,
  reorderPhotos,
  setCoverPhoto,
  deletePhoto,
  moderatePhoto,
  listPendingPhotos,
};
