/**
 * Stays availability tooling — the endpoints behind the Availability submenu.
 *
 * The per-cell calendar endpoints in staysController remain the primitive used
 * by a single editor panel. This controller adds the range operations a real
 * calendar needs:
 *
 *   - one aggregate calendar response (rooms + rate plans + overrides + rules)
 *   - bulk open/close across rooms and dates
 *   - copy a date range's rates/restrictions onto future dates
 *   - date/day/room restriction rules that the booking validator enforces
 *   - property-level value adds
 *
 * Every query starts from a property owned by `req.supplierId`; an id from
 * another supplier resolves to 404 before any write.
 */

const prisma = require('../../core/services/prismaClient');
const AppError = require('../../core/services/appError');
const catchAsync = require('../../core/services/catchAsync');
const {
  supplierIdFor,
  findOwnedProperty,
  objectOrEmpty,
  dateKey,
  parseDateKey,
  addDays,
} = require('./staysShared');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CALENDAR_DAYS = 731;
const MAX_BULK_DAYS = 366;
const MAX_BULK_CELLS = 5000;
const MAX_COPY_DAYS = 366;
const MAX_COPY_CELLS = 1000;

const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const WEEKDAY_SET = new Set(WEEKDAY_NAMES);

const COPY_FIELDS = new Set(['price', 'count', 'minStay', 'closed']);
const VALUE_ADD_UNITS = new Set(['PER_STAY', 'PER_NIGHT', 'PER_PERSON']);

function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Inclusive day count between two midnight-UTC dates. */
function inclusiveDays(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1;
}

function dateRange(from, to) {
  const dates = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function parseRange(fromValue, toValue, { fallbackDays = 30, maxDays = MAX_CALENDAR_DAYS } = {}) {
  const from = fromValue ? parseDateKey(fromValue) : todayUtc();
  if (!from) throw new AppError('Invalid start date', 400);

  const to = toValue ? parseDateKey(toValue) : addDays(from, fallbackDays);
  if (!to) throw new AppError('Invalid end date', 400);
  if (to < from) throw new AppError('End date cannot be before start date', 400);

  const days = inclusiveDays(from, to);
  if (days > maxDays) {
    throw new AppError(`Choose a range of ${maxDays} days or fewer`, 400);
  }

  return { from, to, days };
}

function propertyRooms(property) {
  const data = objectOrEmpty(property.data);
  return {
    data,
    rooms: Array.isArray(data.rooms) ? data.rooms : [],
    ratePlans: Array.isArray(data.ratePlans) ? data.ratePlans : [],
    currency: typeof data.currency === 'string' && data.currency ? data.currency : 'GHS',
  };
}

function validateRoomIds(roomIds, rooms) {
  const known = new Set(rooms.map((room) => room.id));
  const unique = [...new Set(roomIds)];
  const unknown = unique.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new AppError(`Room not found on this property: ${unknown.join(', ')}`, 400);
  }
  if (!unique.length) throw new AppError('Choose at least one room', 400);
  return unique;
}

function normalizeWeekdays(input) {
  if (!Array.isArray(input)) return [];
  const cleaned = [...new Set(input.map((day) => String(day).toLowerCase()))];
  const invalid = cleaned.filter((day) => !WEEKDAY_SET.has(day));
  if (invalid.length) throw new AppError(`Invalid weekday: ${invalid[0]}`, 400);
  return cleaned;
}

function normalizeRoomIds(input, rooms) {
  if (!Array.isArray(input)) return [];
  const unique = [...new Set(input.map(String))];
  if (!unique.length) return [];
  return validateRoomIds(unique, rooms);
}

function optionalInt(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 1) {
    throw new AppError(`${field} must be a whole number of at least 1`, 400);
  }
  return number;
}

function optionalPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new AppError('Price must be zero or more', 400);
  }
  return number;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function serializeRestrictionRule(row) {
  return {
    id: row.id,
    propertyId: row.propertyId,
    name: row.name || '',
    startDate: row.startDate ? dateKey(row.startDate) : null,
    endDate: row.endDate ? dateKey(row.endDate) : null,
    weekdays: Array.isArray(row.weekdays) ? row.weekdays : [],
    roomIds: Array.isArray(row.roomIds) ? row.roomIds : [],
    minStay: row.minStay ?? null,
    maxStay: row.maxStay ?? null,
    stopSell: Boolean(row.stopSell),
    closedToArrival: Boolean(row.closedToArrival),
    closedToDeparture: Boolean(row.closedToDeparture),
    isActive: Boolean(row.isActive),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildRestrictionRuleData(body, rooms, existing = null) {
  const name = hasOwn(body, 'name')
    ? (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null)
    : (existing?.name || null);

  const startDate = hasOwn(body, 'startDate')
    ? (body.startDate ? parseDateKey(body.startDate) : null)
    : (existing?.startDate || null);
  const endDate = hasOwn(body, 'endDate')
    ? (body.endDate ? parseDateKey(body.endDate) : null)
    : (existing?.endDate || null);

  if (startDate && endDate && endDate < startDate) {
    throw new AppError('Restriction end date cannot be before its start date', 400);
  }

  const weekdays = hasOwn(body, 'weekdays')
    ? normalizeWeekdays(body.weekdays)
    : (existing?.weekdays || []);

  const roomIds = hasOwn(body, 'roomIds')
    ? normalizeRoomIds(body.roomIds, rooms)
    : (existing?.roomIds || []);
  // An existing rule must still point at rooms that exist after a room rename.
  if (roomIds.length) {
    const known = new Set(rooms.map((room) => room.id));
    const unknown = roomIds.filter((id) => !known.has(id));
    if (unknown.length) throw new AppError(`Room not found on this property: ${unknown.join(', ')}`, 400);
  }

  const minStay = hasOwn(body, 'minStay')
    ? optionalInt(body.minStay, 'Minimum stay')
    : (existing?.minStay ?? null);
  const maxStay = hasOwn(body, 'maxStay')
    ? optionalInt(body.maxStay, 'Maximum stay')
    : (existing?.maxStay ?? null);

  if (minStay != null && maxStay != null && maxStay < minStay) {
    throw new AppError('Maximum stay cannot be less than minimum stay', 400);
  }

  const stopSell = hasOwn(body, 'stopSell') ? Boolean(body.stopSell) : Boolean(existing?.stopSell);
  const closedToArrival = hasOwn(body, 'closedToArrival')
    ? Boolean(body.closedToArrival)
    : Boolean(existing?.closedToArrival);
  const closedToDeparture = hasOwn(body, 'closedToDeparture')
    ? Boolean(body.closedToDeparture)
    : Boolean(existing?.closedToDeparture);
  const isActive = hasOwn(body, 'isActive') ? Boolean(body.isActive) : (existing?.isActive ?? true);

  if (
    !stopSell
    && !closedToArrival
    && !closedToDeparture
    && minStay == null
    && maxStay == null
  ) {
    throw new AppError(
      'Add at least one restriction: minimum stay, maximum stay, stop-sell, closed to arrival or closed to departure',
      400,
    );
  }

  return {
    name,
    startDate,
    endDate,
    weekdays,
    roomIds,
    minStay,
    maxStay,
    stopSell,
    closedToArrival,
    closedToDeparture,
    isActive,
  };
}

function serializeValueAdd(row) {
  return {
    id: row.id,
    propertyId: row.propertyId,
    name: row.name,
    description: row.description || '',
    price: Number(row.price),
    unit: row.unit,
    isActive: Boolean(row.isActive),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildValueAddData(body, existing = null) {
  const name = hasOwn(body, 'name')
    ? (typeof body.name === 'string' ? body.name.trim() : '')
    : (existing?.name || '');
  if (!name) throw new AppError('Value add name is required', 400);

  const price = hasOwn(body, 'price') ? optionalPrice(body.price) : optionalPrice(existing?.price);
  if (price === null) throw new AppError('Value add price is required', 400);

  const unit = String(
    hasOwn(body, 'unit') ? body.unit : (existing?.unit || 'PER_STAY'),
  ).toUpperCase();
  if (!VALUE_ADD_UNITS.has(unit)) throw new AppError('Invalid value add unit', 400);

  const description = hasOwn(body, 'description')
    ? (typeof body.description === 'string' && body.description.trim()
      ? body.description.trim()
      : null)
    : (existing?.description || null);

  const isActive = hasOwn(body, 'isActive') ? Boolean(body.isActive) : (existing?.isActive ?? true);
  const sortOrder = hasOwn(body, 'sortOrder')
    ? Math.max(0, Math.trunc(Number(body.sortOrder) || 0))
    : (existing?.sortOrder ?? 0);

  return { name, description, price, unit, isActive, sortOrder };
}

/** Fields that count as "already set" when overwrite is off. */
function hasCopyValue(row, field) {
  if (!row) return false;
  if (field === 'closed') return row.closed === true;
  return row[field] !== null && row[field] !== undefined;
}

/**
 * Build the write plan for a rate copy without touching the database.
 *
 * `closed` is only copied when the source night is closed; copying `false`
 * would create meaningless rows for every open date.
 */
function planRateCopy({
  sourceRows,
  targetRows,
  roomIds,
  sourceFrom,
  sourceDays,
  targetStart,
  fields,
  overwrite,
}) {
  const sourceByKey = new Map(
    sourceRows.map((row) => [`${row.roomId}|${dateKey(row.date)}`, row]),
  );
  const targetByKey = new Map(
    targetRows.map((row) => [`${row.roomId}|${dateKey(row.date)}`, row]),
  );

  const operations = [];
  let considered = 0;
  let skipped = 0;

  for (const roomId of roomIds) {
    for (let offset = 0; offset < sourceDays; offset += 1) {
      const sourceKey = `${roomId}|${dateKey(addDays(sourceFrom, offset))}`;
      const source = sourceByKey.get(sourceKey);
      const targetDate = addDays(targetStart, offset);
      const target = targetByKey.get(`${roomId}|${dateKey(targetDate)}`);

      const copiesSourceValue = fields.some((field) => hasCopyValue(source, field));
      if (!copiesSourceValue) continue;
      considered += 1;

      const data = {};
      for (const field of fields) {
        if (!hasCopyValue(source, field)) continue;
        if (!overwrite && hasCopyValue(target, field)) continue;
        data[field] = field === 'price' ? Number(source.price) : source[field];
      }

      if (Object.keys(data).length === 0) {
        skipped += 1;
        continue;
      }

      operations.push({ roomId, date: targetDate, data });
    }
  }

  return { operations, considered, skipped };
}

/* ── Calendar ──────────────────────────────────────────────────────────── */

exports.getCalendar = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const property = await findOwnedProperty(req.params.id, supplierId);
  const { data, rooms, ratePlans, currency } = propertyRooms(property);
  const { from, to, days } = parseRange(req.query?.from, req.query?.to);

  const roomId = req.query?.roomId || null;
  if (roomId && !rooms.some((room) => room.id === roomId)) {
    throw new AppError('Room not found on this property', 400);
  }

  const overrideWhere = {
    propertyId: property.id,
    date: { gte: from, lte: to },
  };
  if (roomId) overrideWhere.roomId = roomId;

  const [overrideRows, ruleRows] = await Promise.all([
    prisma.stayAvailabilityOverride.findMany({
      where: overrideWhere,
      orderBy: { date: 'asc' },
    }),
    prisma.stayRestrictionRule.findMany({
      where: {
        propertyId: property.id,
        isActive: true,
        AND: [
          { OR: [{ startDate: null }, { startDate: { lte: to } }] },
          { OR: [{ endDate: null }, { endDate: { gte: from } }] },
        ],
      },
      orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);

  const overrides = {};
  for (const row of overrideRows) {
    if (roomId && row.roomId !== roomId) continue;
    if (!rooms.some((room) => room.id === row.roomId)) continue;
    const value = {};
    if (row.count !== null) value.count = row.count;
    if (row.closed) value.closed = true;
    if (row.price !== null) value.price = Number(row.price);
    if (row.minStay !== null) value.minStay = row.minStay;
    overrides[`${row.roomId}|${dateKey(row.date)}`] = value;
  }

  const rules = ruleRows.filter(
    (rule) => !roomId || !rule.roomIds?.length || rule.roomIds.includes(roomId),
  );

  res.status(200).json({
    status: 'success',
    data: {
      property: {
        id: property.id,
        name: property.name,
        currency,
        timezone: typeof data.timezone === 'string' && data.timezone ? data.timezone : 'Africa/Accra',
      },
      range: { from: dateKey(from), to: dateKey(to), days },
      rooms: roomId ? rooms.filter((room) => room.id === roomId) : rooms,
      ratePlans: roomId ? ratePlans.filter((plan) => plan.roomId === roomId) : ratePlans,
      overrides,
      rules: rules.map(serializeRestrictionRule),
      currency,
    },
  });
});

/* ── Bulk open / close ─────────────────────────────────────────────────── */

exports.bulkAvailability = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const property = await findOwnedProperty(req.params.id, supplierId);
  const { rooms } = propertyRooms(property);
  const { action, roomIds, from, to } = req.body || {};

  if (action !== 'close' && action !== 'open') {
    throw new AppError('Action must be close or open', 400);
  }

  const uniqueRoomIds = validateRoomIds(roomIds || [], rooms);
  const range = parseRange(from, to, { maxDays: MAX_BULK_DAYS });
  const cells = uniqueRoomIds.length * range.days;

  if (cells > MAX_BULK_CELLS) {
    throw new AppError(
      `That is ${cells} room-nights; update ${MAX_BULK_CELLS} or fewer at a time`,
      400,
    );
  }

  const affected = await prisma.$transaction(async (tx) => {
    const where = {
      propertyId: property.id,
      roomId: { in: uniqueRoomIds },
      date: { gte: range.from, lte: range.to },
    };

    if (action === 'close') {
      const now = new Date();
      const rows = [];
      for (const date of dateRange(range.from, range.to)) {
        for (const roomId of uniqueRoomIds) {
          rows.push({
            propertyId: property.id,
            roomId,
            date,
            closed: true,
            updatedAt: now,
          });
        }
      }
      await tx.stayAvailabilityOverride.createMany({ data: rows, skipDuplicates: true });
      await tx.stayAvailabilityOverride.updateMany({
        where: { ...where, closed: false },
        data: { closed: true },
      });
      return cells;
    }

    const updated = await tx.stayAvailabilityOverride.updateMany({
      where,
      data: { closed: false },
    });
    // Rows that only existed to mark the night closed carry no information
    // once it is open again; removing them keeps the calendar payload small.
    await tx.stayAvailabilityOverride.deleteMany({
      where: {
        ...where,
        closed: false,
        count: null,
        price: null,
        minStay: null,
      },
    });
    return updated.count;
  });

  res.status(200).json({
    status: 'success',
    data: {
      action,
      from: dateKey(range.from),
      to: dateKey(range.to),
      roomIds: uniqueRoomIds,
      rooms: uniqueRoomIds.length,
      days: range.days,
      affected,
    },
  });
});

/* ── Copy rates to future dates ────────────────────────────────────────── */

exports.copyAvailability = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const property = await findOwnedProperty(req.params.id, supplierId);
  const { rooms } = propertyRooms(property);
  const body = req.body || {};

  const uniqueRoomIds = validateRoomIds(body.roomIds || [], rooms);
  const source = parseRange(body.sourceFrom, body.sourceTo, { maxDays: MAX_COPY_DAYS });
  const targetStart = parseDateKey(body.targetStart);
  if (!targetStart) throw new AppError('Invalid target start date', 400);

  const sourceDays = source.days;
  const targetEnd = addDays(targetStart, sourceDays - 1);
  const cells = uniqueRoomIds.length * sourceDays;
  if (cells > MAX_COPY_CELLS) {
    throw new AppError(
      `That is ${cells} room-nights; copy ${MAX_COPY_CELLS} or fewer at a time`,
      400,
    );
  }

  const fields = [...new Set(body.fields && body.fields.length ? body.fields : ['price'])];
  const invalidField = fields.find((field) => !COPY_FIELDS.has(field));
  if (invalidField) throw new AppError(`Invalid copy field: ${invalidField}`, 400);

  const overwrite = Boolean(body.overwrite);
  const dryRun = Boolean(body.dryRun);

  const [sourceRows, targetRows] = await Promise.all([
    prisma.stayAvailabilityOverride.findMany({
      where: {
        propertyId: property.id,
        roomId: { in: uniqueRoomIds },
        date: { gte: source.from, lte: source.to },
      },
    }),
    prisma.stayAvailabilityOverride.findMany({
      where: {
        propertyId: property.id,
        roomId: { in: uniqueRoomIds },
        date: { gte: targetStart, lte: targetEnd },
      },
    }),
  ]);

  const plan = planRateCopy({
    sourceRows,
    targetRows,
    roomIds: uniqueRoomIds,
    sourceFrom: source.from,
    sourceDays,
    targetStart,
    fields,
    overwrite,
  });

  if (dryRun) {
    return res.status(200).json({
      status: 'success',
      data: {
        dryRun: true,
        source: { from: dateKey(source.from), to: dateKey(source.to), days: sourceDays },
        target: { from: dateKey(targetStart), to: dateKey(targetEnd), days: sourceDays },
        roomIds: uniqueRoomIds,
        fields,
        wouldCopy: plan.operations.length,
        wouldSkip: plan.skipped,
        preview: plan.operations.slice(0, 200).map((operation) => ({
          roomId: operation.roomId,
          date: dateKey(operation.date),
          fields: operation.data,
        })),
      },
    });
  }

  await prisma.$transaction(
    async (tx) => {
      for (const operation of plan.operations) {
        await tx.stayAvailabilityOverride.upsert({
          where: {
            propertyId_roomId_date: {
              propertyId: property.id,
              roomId: operation.roomId,
              date: operation.date,
            },
          },
          create: {
            propertyId: property.id,
            roomId: operation.roomId,
            date: operation.date,
            ...operation.data,
          },
          update: operation.data,
        });
      }
    },
    { timeout: 30000, maxWait: 10000 },
  );

  res.status(200).json({
    status: 'success',
    data: {
      dryRun: false,
      source: { from: dateKey(source.from), to: dateKey(source.to), days: sourceDays },
      target: { from: dateKey(targetStart), to: dateKey(targetEnd), days: sourceDays },
      roomIds: uniqueRoomIds,
      fields,
      copied: plan.operations.length,
      skipped: plan.skipped,
    },
  });
});

/* ── Restriction rules ─────────────────────────────────────────────────── */

exports.listRestrictionRules = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const property = await findOwnedProperty(req.params.id, supplierId);
  const { rooms, currency } = propertyRooms(property);

  const rules = await prisma.stayRestrictionRule.findMany({
    where: { propertyId: property.id },
    orderBy: [{ isActive: 'desc' }, { startDate: 'asc' }, { createdAt: 'desc' }],
  });

  res.status(200).json({
    status: 'success',
    data: { rules: rules.map(serializeRestrictionRule), rooms, currency },
  });
});

exports.createRestrictionRule = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const property = await findOwnedProperty(req.params.id, supplierId);
  const { rooms } = propertyRooms(property);
  const data = buildRestrictionRuleData(req.body || {}, rooms);

  const rule = await prisma.stayRestrictionRule.create({
    data: { propertyId: property.id, ...data },
  });

  res.status(201).json({
    status: 'success',
    data: { rule: serializeRestrictionRule(rule) },
  });
});

exports.updateRestrictionRule = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const property = await findOwnedProperty(req.params.id, supplierId);
  const { rooms } = propertyRooms(property);

  const existing = await prisma.stayRestrictionRule.findFirst({
    where: { id: req.params.ruleId, propertyId: property.id },
  });
  if (!existing) throw new AppError('Restriction rule not found', 404);

  const data = buildRestrictionRuleData(req.body || {}, rooms, existing);
  const rule = await prisma.stayRestrictionRule.update({
    where: { id: existing.id },
    data,
  });

  res.status(200).json({
    status: 'success',
    data: { rule: serializeRestrictionRule(rule) },
  });
});

exports.deleteRestrictionRule = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const property = await findOwnedProperty(req.params.id, supplierId);

  const deleted = await prisma.stayRestrictionRule.deleteMany({
    where: { id: req.params.ruleId, propertyId: property.id },
  });
  if (!deleted.count) throw new AppError('Restriction rule not found', 404);

  res.status(200).json({ status: 'success', data: { ok: true } });
});

/* ── Value adds ────────────────────────────────────────────────────────── */

exports.listValueAdds = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const property = await findOwnedProperty(req.params.id, supplierId);
  const { currency } = propertyRooms(property);

  const valueAdds = await prisma.stayValueAdd.findMany({
    where: { propertyId: property.id },
    orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  res.status(200).json({
    status: 'success',
    data: { valueAdds: valueAdds.map(serializeValueAdd), currency },
  });
});

exports.createValueAdd = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const property = await findOwnedProperty(req.params.id, supplierId);
  const data = buildValueAddData(req.body || {});

  const valueAdd = await prisma.stayValueAdd.create({
    data: { propertyId: property.id, ...data },
  });

  res.status(201).json({
    status: 'success',
    data: { valueAdd: serializeValueAdd(valueAdd) },
  });
});

exports.updateValueAdd = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const property = await findOwnedProperty(req.params.id, supplierId);

  const existing = await prisma.stayValueAdd.findFirst({
    where: { id: req.params.valueAddId, propertyId: property.id },
  });
  if (!existing) throw new AppError('Value add not found', 404);

  const data = buildValueAddData(req.body || {}, existing);
  const valueAdd = await prisma.stayValueAdd.update({
    where: { id: existing.id },
    data,
  });

  res.status(200).json({
    status: 'success',
    data: { valueAdd: serializeValueAdd(valueAdd) },
  });
});

exports.deleteValueAdd = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const property = await findOwnedProperty(req.params.id, supplierId);

  const deleted = await prisma.stayValueAdd.deleteMany({
    where: { id: req.params.valueAddId, propertyId: property.id },
  });
  if (!deleted.count) throw new AppError('Value add not found', 404);

  res.status(200).json({ status: 'success', data: { ok: true } });
});

// Exported for unit tests.
exports._private = {
  parseRange,
  inclusiveDays,
  planRateCopy,
  buildRestrictionRuleData,
  serializeRestrictionRule,
  buildValueAddData,
  serializeValueAdd,
  normalizeWeekdays,
};
