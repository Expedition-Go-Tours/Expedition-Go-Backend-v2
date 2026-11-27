/**
 * Structured menus.
 *
 * The editor saves a whole menu document (sections + items) in one transaction.
 * That is deliberate: a two-pane editor that saves field-by-field needs a dozen
 * endpoints, a draft state per row and a reconciliation rule for concurrent
 * tabs. A restaurant menu is a small document, so replacing it atomically is
 * both simpler and safer.
 *
 * Money is stored as integer minor units with an explicit currency. `null`
 * means "market price" and is a real value — rendering it as 0 would be a lie
 * about what a dish costs.
 *
 * `menuUrl` on the venue is untouched. It stays the fallback for a restaurant
 * whose menu lives on their own site, and the detail page prefers structured
 * data only when a published menu exists.
 */

const prisma = require('./prismaClient');
const AppError = require('./appError');
const cache = require('./cacheHelper');
const logger = require('./logger');
const { enqueueEvent } = require('./queue');
const { logActivity } = require('./auditLogger');
const { assertPermission } = require('./restaurantVenueAccess');

const MAX_MENUS = 5;
const MAX_SECTIONS = 20;
const MAX_ITEMS_PER_SECTION = 100;
const MAX_PRICE_MINOR = 100_000_000;
const SUPPORTED_CURRENCIES = ['GHS', 'USD', 'EUR', 'GBP', 'NGN', 'ZAR'];
const MAX_DIETARY_TAGS = 8;

function invalidate(venue) {
  cache
    .invalidateRestaurantVenueCaches(venue.id, venue.slug)
    .catch((err) => logger.warn('[cache] restaurant venue invalidation failed:', err?.message));
}

function money(priceMinor) {
  return priceMinor == null ? null : Math.round(priceMinor);
}

function toItem(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    priceMinor: money(row.priceMinor),
    currency: row.currency,
    dietary: row.dietary || [],
    isAvailable: row.isAvailable,
    position: row.position,
    photoUrl: row.photoUrl ?? null,
  };
}

function toSection(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    position: row.position,
    items: (row.items || [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(toItem),
  };
}

function toMenu(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    status: row.status,
    currency: row.currency,
    position: row.position,
    publishedAt: row.publishedAt ?? null,
    updatedAt: row.updatedAt,
    sections: (row.sections || [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(toSection),
  };
}

const MENU_INCLUDE = {
  sections: {
    orderBy: { position: 'asc' },
    include: { items: { orderBy: { position: 'asc' } } },
  },
};

function text(value, { field, max, required = false }) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new AppError(`${field} is required`, 400, { code: 'MENU_FIELD_REQUIRED' });
    }
    return null;
  }
  const clean = String(value).trim();
  if (!clean) {
    if (required) {
      throw new AppError(`${field} is required`, 400, { code: 'MENU_FIELD_REQUIRED' });
    }
    return null;
  }
  if (clean.length > max) {
    throw new AppError(`${field} can be at most ${max} characters`, 400, {
      code: 'MENU_FIELD_TOO_LONG',
    });
  }
  return clean;
}

function currencyCode(value, fallback = 'GHS') {
  if (value === undefined || value === null || value === '') return fallback;
  const code = String(value).trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(code)) {
    throw new AppError(`Currency must be one of ${SUPPORTED_CURRENCIES.join(', ')}`, 400, {
      code: 'UNSUPPORTED_CURRENCY',
    });
  }
  return code;
}

function dietaryTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AppError('Dietary tags must be a list', 400, { code: 'INVALID_DIETARY' });
  }
  const tags = [...new Set(value.map((tag) => String(tag).trim()).filter(Boolean))];
  if (tags.length > MAX_DIETARY_TAGS) {
    throw new AppError(`An item can have at most ${MAX_DIETARY_TAGS} dietary tags`, 400, {
      code: 'TOO_MANY_DIETARY_TAGS',
    });
  }
  if (tags.some((tag) => tag.length > 40)) {
    throw new AppError('A dietary tag can be at most 40 characters', 400, {
      code: 'DIETARY_TAG_TOO_LONG',
    });
  }
  return tags;
}

function price(value) {
  if (value === undefined || value === null || value === '') return null;
  const minor = Number(value);
  if (!Number.isInteger(minor) || minor < 0 || minor > MAX_PRICE_MINOR) {
    throw new AppError('Price must be a whole number of minor units', 400, {
      code: 'INVALID_PRICE',
    });
  }
  return minor;
}

function normalizeSections(value) {
  if (!Array.isArray(value)) {
    throw new AppError('Sections must be a list', 400, { code: 'INVALID_SECTIONS' });
  }
  if (value.length > MAX_SECTIONS) {
    throw new AppError(`A menu can have at most ${MAX_SECTIONS} sections`, 400, {
      code: 'TOO_MANY_SECTIONS',
    });
  }
  return value.map((section, sectionIndex) => {
    const items = Array.isArray(section.items) ? section.items : [];
    if (items.length > MAX_ITEMS_PER_SECTION) {
      throw new AppError(
        `A section can have at most ${MAX_ITEMS_PER_SECTION} items`,
        400,
        { code: 'TOO_MANY_ITEMS' },
      );
    }
    return {
      title: text(section.title, { field: 'Section title', max: 80, required: true }),
      description: text(section.description, { field: 'Section description', max: 400 }),
      position: sectionIndex,
      items: items.map((item, itemIndex) => ({
        name: text(item.name, { field: 'Item name', max: 120, required: true }),
        description: text(item.description, { field: 'Item description', max: 600 }),
        priceMinor: price(item.priceMinor),
        dietary: dietaryTags(item.dietary),
        isAvailable: item.isAvailable === undefined ? true : Boolean(item.isAvailable),
        position: itemIndex,
        photoUrl: item.photoUrl ? String(item.photoUrl).trim() : null,
      })),
    };
  });
}

async function listMenus(context) {
  assertPermission(context, 'menu.manage');
  const rows = await prisma.restaurantMenu.findMany({
    where: { venueId: context.venue.id },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    include: MENU_INCLUDE,
  });
  return {
    menus: rows.map(toMenu),
    menuUrl: context.venue.menuUrl || null,
    limit: MAX_MENUS,
  };
}

async function saveMenu(context, input, req) {
  assertPermission(context, 'menu.manage');
  const venueId = context.venue.id;

  const name = text(input.name, { field: 'Menu name', max: 80 }) || 'Main menu';
  const description = text(input.description, { field: 'Menu description', max: 400 });
  const currency = currencyCode(input.currency);
  const sections = normalizeSections(input.sections);

  let savedId;
  if (input.id) {
    const existing = await prisma.restaurantMenu.findFirst({
      where: { id: String(input.id), venueId },
      select: { id: true },
    });
    if (!existing) throw new AppError('Menu not found', 404, { code: 'MENU_NOT_FOUND' });
    savedId = existing.id;
  } else {
    const count = await prisma.restaurantMenu.count({ where: { venueId } });
    if (count >= MAX_MENUS) {
      throw new AppError(`A listing can have at most ${MAX_MENUS} menus`, 400, {
        code: 'MENU_LIMIT_REACHED',
      });
    }
  }

  let saved;
  try {
    saved = await prisma.$transaction(async (tx) => {
      let menu;
      if (savedId) {
        menu = await tx.restaurantMenu.update({
          where: { id: savedId },
          data: { name, description, currency },
        });
        // Items cascade from the sections, so this replaces the document.
        await tx.restaurantMenuSection.deleteMany({ where: { menuId: savedId } });
      } else {
        const last = await tx.restaurantMenu.findFirst({
          where: { venueId },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        menu = await tx.restaurantMenu.create({
          data: {
            venueId,
            name,
            description,
            currency,
            status: 'DRAFT',
            position: (last ? last.position : 0) + 1,
          },
        });
      }

      for (const section of sections) {
        await tx.restaurantMenuSection.create({
          data: {
            menuId: menu.id,
            title: section.title,
            description: section.description,
            position: section.position,
            items: {
              create: section.items.map((item) => ({
                name: item.name,
                description: item.description,
                priceMinor: item.priceMinor,
                currency,
                dietary: item.dietary,
                isAvailable: item.isAvailable,
                position: item.position,
                photoUrl: item.photoUrl,
              })),
            },
          },
        });
      }

      return tx.restaurantMenu.findUnique({
        where: { id: menu.id },
        include: MENU_INCLUDE,
      });
    });
  } catch (error) {
    if (error && error.code === 'P2002') {
      throw new AppError('You already have a menu with that name', 409, {
        code: 'MENU_NAME_TAKEN',
      });
    }
    throw error;
  }

  invalidate(context.venue);

  const itemCount = sections.reduce((sum, section) => sum + section.items.length, 0);
  await logActivity({
    userId: context.membership.userId,
    action: savedId ? 'restaurantMenu.updated' : 'restaurantMenu.created',
    resource: 'RestaurantMenu',
    resourceId: saved.id,
    metadata: {
      venueId,
      menuId: saved.id,
      sections: sections.length,
      items: itemCount,
      currency,
    },
  });
  enqueueEvent({
    name: savedId ? 'restaurant_menu.updated' : 'restaurant_menu.created',
    userId: context.membership.userId,
    req,
    resource: 'RestaurantMenu',
    resourceId: saved.id,
    properties: { venueId, sections: sections.length, items: itemCount },
  });

  return toMenu(saved);
}

async function publishMenu(context, { menuId }, req) {
  assertPermission(context, 'menu.manage');
  const venueId = context.venue.id;

  const menu = await prisma.restaurantMenu.findFirst({
    where: { id: menuId, venueId },
    include: MENU_INCLUDE,
  });
  if (!menu) throw new AppError('Menu not found', 404, { code: 'MENU_NOT_FOUND' });

  const sectionCount = menu.sections.length;
  const itemCount = menu.sections.reduce((sum, section) => sum + section.items.length, 0);
  if (sectionCount === 0 || itemCount === 0) {
    throw new AppError('Add at least one section and one dish before publishing', 400, {
      code: 'MENU_EMPTY',
    });
  }

  const updated = await prisma.restaurantMenu.update({
    where: { id: menu.id },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
    include: MENU_INCLUDE,
  });

  invalidate(context.venue);
  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantMenu.published',
    resource: 'RestaurantMenu',
    resourceId: menu.id,
    metadata: { venueId, menuId: menu.id, sections: sectionCount, items: itemCount },
  });
  enqueueEvent({
    name: 'restaurant_menu.published',
    userId: context.membership.userId,
    req,
    resource: 'RestaurantMenu',
    resourceId: menu.id,
    properties: { venueId, sections: sectionCount, items: itemCount },
  });

  return toMenu(updated);
}

async function unpublishMenu(context, { menuId }, req) {
  assertPermission(context, 'menu.manage');
  const menu = await prisma.restaurantMenu.findFirst({
    where: { id: menuId, venueId: context.venue.id },
    select: { id: true },
  });
  if (!menu) throw new AppError('Menu not found', 404, { code: 'MENU_NOT_FOUND' });

  const updated = await prisma.restaurantMenu.update({
    where: { id: menu.id },
    data: { status: 'DRAFT' },
    include: MENU_INCLUDE,
  });

  invalidate(context.venue);
  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantMenu.unpublished',
    resource: 'RestaurantMenu',
    resourceId: menu.id,
    metadata: { venueId: context.venue.id, menuId: menu.id },
  });
  enqueueEvent({
    name: 'restaurant_menu.unpublished',
    userId: context.membership.userId,
    req,
    resource: 'RestaurantMenu',
    resourceId: menu.id,
    properties: { venueId: context.venue.id },
  });

  return toMenu(updated);
}

async function deleteMenu(context, { menuId }, req) {
  assertPermission(context, 'menu.manage');
  const menu = await prisma.restaurantMenu.findFirst({
    where: { id: menuId, venueId: context.venue.id },
    select: { id: true, name: true, status: true },
  });
  if (!menu) throw new AppError('Menu not found', 404, { code: 'MENU_NOT_FOUND' });

  await prisma.restaurantMenu.delete({ where: { id: menu.id } });
  invalidate(context.venue);

  await logActivity({
    userId: context.membership.userId,
    action: 'restaurantMenu.deleted',
    resource: 'RestaurantMenu',
    resourceId: menu.id,
    metadata: { venueId: context.venue.id, menuId: menu.id, name: menu.name },
  });
  enqueueEvent({
    name: 'restaurant_menu.deleted',
    userId: context.membership.userId,
    req,
    resource: 'RestaurantMenu',
    resourceId: menu.id,
    properties: { venueId: context.venue.id },
  });

  return { id: menu.id };
}

/** Published menus for the public detail DTO. Never called on a write path. */
async function getPublicMenus(venueId) {
  const rows = await prisma.restaurantMenu.findMany({
    where: { venueId, status: 'PUBLISHED' },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    include: MENU_INCLUDE,
  });
  return rows.map(toMenu);
}

module.exports = {
  MAX_MENUS,
  MAX_SECTIONS,
  MAX_ITEMS_PER_SECTION,
  listMenus,
  saveMenu,
  publishMenu,
  unpublishMenu,
  deleteMenu,
  getPublicMenus,
  toMenu,
};
