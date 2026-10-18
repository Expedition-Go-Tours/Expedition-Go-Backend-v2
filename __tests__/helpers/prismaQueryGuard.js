/**
 * Validates Prisma query shapes against the real schema (DMMF).
 *
 * Why this exists
 * ---------------
 * The unit tests mock `prismaClient` with bare `jest.fn()`s. That is right for
 * testing what a controller *does* with rows, but it means nothing ever checks
 * that the query it builds is one Prisma would accept. A typo'd column in a
 * `select` sails through the whole suite and only surfaces in production as a
 * 500 from `PrismaClientValidationError` — which is exactly how
 * `imageCover` (a field that has never existed on `Tour`; it is
 * `coverPhoto`) shipped on the invoice detail and PDF endpoints.
 *
 * This helper closes that gap: it walks a captured query's `args` and checks
 * every `select`, `include` and nested relation against the DMMF of the real
 * `prisma/schema.prisma`. It is deliberately a *validator*, not a mock — it
 * reports the exact path of the bad field so the failure reads like the
 * Prisma error it prevents.
 *
 * Usage in a test:
 *
 *   const { assertQueryShape } = require('../helpers/prismaQueryGuard');
 *
 *   assertQueryShape('Invoice', prisma.invoice.findFirst.mock.calls[0][0]);
 *
 * or drive a whole controller and check every query it issued:
 *
 *   const { assertAllQueriesValid } = require('../helpers/prismaQueryGuard');
 *   const prisma = makeRecordingPrisma();   // see below
 *   await getInvoiceById(req, res, next);
 *   assertAllQueriesValid(prisma);
 */
const { Prisma } = require('@prisma/client');

const dmmf = Prisma.dmmf;
const MODELS = new Map(dmmf.datamodel.models.map((m) => [m.name, m]));

/**
 * Build a `Map<modelName, Map<fieldName, field>>` once. Field lookup is the
 * hot path here, and a nested map keeps it O(1) instead of scanning 62 models.
 */
const MODEL_FIELDS = new Map(
  dmmf.datamodel.models.map((m) => [m.name, new Map(m.fields.map((f) => [f.name, f]))])
);

/** Relation-write keys: `{ connect: { id } }` etc. These take no field checks. */
const RELATION_WRITE_KEYS = new Set([
  'create', 'createMany', 'connect', 'connectOrCreate',
  'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'set',
]);

/** Aggregate result keys — not fields. */
const AGGREGATE_KEYS = new Set(['_sum', '_avg', '_count', '_min', '_max']);

/** Relation-filter operators in a `where`: `{ review: { is: null } }` etc. */
const RELATION_FILTER_KEYS = ['is', 'isNot', 'some', 'every', 'none'];

class PrismaQueryShapeError extends Error {
  constructor(path, message) {
    super(`Invalid Prisma query at ${path}: ${message}`);
    this.name = 'PrismaQueryShapeError';
    this.path = path;
  }
}

/**
 * Resolve the model a relation field points at, or null for a scalar.
 * `field.kind === 'object'` is Prisma's marker for a relation; `field.type`
 * then holds the *model* name (unlike scalars, where it is the scalar type).
 */
function relatedModelName(field) {
  return field && field.kind === 'object' ? field.type : null;
}

function fieldOf(modelName, fieldName) {
  const fields = MODEL_FIELDS.get(modelName);
  if (!fields) throw new PrismaQueryShapeError(modelName, 'unknown model');
  return fields.get(fieldName);
}

function hasField(modelName, fieldName) {
  return Boolean(MODEL_FIELDS.get(modelName)?.has(fieldName));
}

/**
 * Compound unique keys, as `@@unique([a, b])`, plus compound primary keys
 * `@@id([a, b])`, which behave the same way in a `where`.
 *
 * Prisma addresses these by joining the field names with an underscore:
 * `where: { tourId_date: { tourId, date } }`. That is not a field, so a naive
 * `where` check flags every one of them — there are 17 such keys in this
 * schema and they account for most of what the sweep would otherwise report.
 * Building the set once keeps the check O(1).
 */
const COMPOUND_UNIQUES = new Map(
  dmmf.datamodel.models.map((m) => {
    const keys = new Set();
    for (const index of m.uniqueIndexes || []) {
      if (index.fields.length > 1) keys.add(index.fields.join('_'));
    }
    if (m.primaryKey && m.primaryKey.fields.length > 1) {
      keys.add(m.primaryKey.fields.join('_'));
    }
    return [m.name, keys];
  })
);

function hasCompoundUnique(modelName, key) {
  return Boolean(COMPOUND_UNIQUES.get(modelName)?.has(key));
}

/**
 * Validate the `select`/`include` block of a query or nested relation.
 *
 * `block` is the object handed to `select` or `include`. Each key must be a
 * real field on `modelName`; when the value is itself an object, the key must
 * be a relation and we recurse into the related model's own block. A scalar
 * with an object value is Prisma's "select sub-fields of a scalar" (JSON) and
 * is not checked further.
 */
function validateSelection(modelName, block, path) {
  if (!block || typeof block !== 'object') return;

  for (const [key, value] of Object.entries(block)) {
    const keyPath = `${path}.${key}`;

    if (key.startsWith('_')) {
      // `_count: { select: { items: true } }` and friends.
      if (value && typeof value === 'object') {
        if (value.select) validateSelection(modelName, value.select, `${keyPath}.select`);
      }
      continue;
    }

    const field = fieldOf(modelName, key);
    if (!field) {
      throw new PrismaQueryShapeError(
        keyPath,
        `unknown field \`${key}\` for select/include on model \`${modelName}\`. ` +
          `Available: ${[...(MODEL_FIELDS.get(modelName)?.keys() || [])].slice(0, 12).join(', ')}…`
      );
    }

    const relModel = relatedModelName(field);
    if (value && typeof value === 'object') {
      if (!relModel) continue; // scalar with a sub-select (JSON path) — skip
      if (value.select) validateSelection(relModel, value.select, `${keyPath}.select`);
      if (value.include) validateSelection(relModel, value.include, `${keyPath}.include`);
      if (value.where) validateWhere(relModel, value.where, `${keyPath}.where`);
      if (value.orderBy) validateOrderBy(relModel, value.orderBy, `${keyPath}.orderBy`);
      if (value.distinct) validateDistinct(relModel, value.distinct, `${keyPath}.distinct`);
    }
  }
}

/** `orderBy` may be a single object, an array, `{ field: 'asc' }` or a relation sort. */
function validateOrderBy(modelName, orderBy, path) {
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    for (const [key, value] of Object.entries(entry)) {
      if (AGGREGATE_KEYS.has(key)) continue; // `_count: { items: 'asc' }`
      const fieldPath = `${path}.${key}`;
      const field = fieldOf(modelName, key);
      if (!field) {
        throw new PrismaQueryShapeError(
          fieldPath,
          `unknown field \`${key}\` in orderBy on model \`${modelName}\``
        );
      }
      const relModel = relatedModelName(field);
      if (relModel && value && typeof value === 'object') {
        validateOrderBy(relModel, value, fieldPath);
      }
    }
  }
}

function validateDistinct(modelName, distinct, path) {
  const keys = Array.isArray(distinct) ? distinct : [distinct];
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    if (!hasField(modelName, key)) {
      throw new PrismaQueryShapeError(
        `${path}.${key}`,
        `unknown field \`${key}\` in distinct on model \`${modelName}\``
      );
    }
  }
}

/**
 * Walk a `where` clause. Top-level keys are fields, compound unique keys, or
 * the AND/OR/NOT groups; a relation key recurses into the related model's
 * `where`; everything else is treated as an operator block and not
 * field-checked.
 */
function validateWhere(modelName, where, path) {
  if (!where || typeof where !== 'object') return;

  for (const [key, value] of Object.entries(where)) {
    const keyPath = `${path}.${key}`;

    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      const clauses = Array.isArray(value) ? value : [value];
      clauses.forEach((clause, i) => validateWhere(modelName, clause, `${keyPath}[${i}]`));
      continue;
    }

    // `where: { tourId_date: { tourId, date } }` — a compound unique lookup.
    // Its payload is a where clause on the *same* model, so it is checked too.
    if (hasCompoundUnique(modelName, key)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        validateWhere(modelName, value, keyPath);
      }
      continue;
    }

    const field = fieldOf(modelName, key);
    if (!field) {
      throw new PrismaQueryShapeError(
        keyPath,
        `unknown field \`${key}\` in where on model \`${modelName}\`. ` +
          `Available: ${[...(MODEL_FIELDS.get(modelName)?.keys() || [])].slice(0, 12).join(', ')}…`
      );
    }

    const relModel = relatedModelName(field);
    if (relModel && value && typeof value === 'object') {
      // A relation filter: either a nested where, or one of the operator keys
      // `{ is }`, `{ isNot }`, `{ some }`, `{ every }`, `{ none }`.
      //
      // The key's *presence* decides, not its value — `{ review: { is: null } }`
      // is a perfectly valid "no review" filter, and testing the payload for
      // truthiness would fall through to treating `is` as a field name.
      const operatorKey = RELATION_FILTER_KEYS.find((k) => k in value);
      if (operatorKey) validateWhere(relModel, value[operatorKey], `${keyPath}.${operatorKey}`);
      else validateWhere(relModel, value, keyPath);
    }
  }
}

/**
 * Validate a full args object for `modelName`. Exported so a test can check any
 * captured call, not just the ones a helper recorded.
 */
function assertQueryShape(modelName, args, label = 'query') {
  if (!MODELS.has(modelName)) {
    throw new PrismaQueryShapeError(label, `unknown model \`${modelName}\``);
  }
  if (!args || typeof args !== 'object') return;

  if (args.select) validateSelection(modelName, args.select, `${label}.select`);
  if (args.include) validateSelection(modelName, args.include, `${label}.include`);
  if (args.where) validateWhere(modelName, args.where, `${label}.where`);
  if (args.orderBy) validateOrderBy(modelName, args.orderBy, `${label}.orderBy`);
  if (args.distinct) validateDistinct(modelName, args.distinct, `${label}.distinct`);
  if (args.data && typeof args.data === 'object') {
    validateData(modelName, args.data, `${label}.data`);
  }
}

/**
 * `data` for create/update. Keys are fields, relation-write keys, or relation
 * fields taking a nested write. Scalars' values are not type-checked — the
 * schema is, and Prisma's own runtime validation covers the rest.
 */
function validateData(modelName, data, path) {
  for (const [key, value] of Object.entries(data)) {
    if (RELATION_WRITE_KEYS.has(key)) continue;
    const keyPath = `${path}.${key}`;
    const field = fieldOf(modelName, key);
    if (!field) {
      throw new PrismaQueryShapeError(
        keyPath,
        `unknown field \`${key}\` in data on model \`${modelName}\``
      );
    }
    const relModel = relatedModelName(field);
    if (relModel && value && typeof value === 'object') {
      for (const [op, payload] of Object.entries(value)) {
        if (RELATION_WRITE_KEYS.has(op) && payload && typeof payload === 'object') {
          // `{ connect: { id } }` — keys are fields of the related model.
          const inner = Array.isArray(payload) ? payload : [payload];
          inner.forEach((item, i) => validateData(relModel, item, `${keyPath}.${op}[${i}]`));
        }
      }
    }
  }
}

/**
 * A recording stand-in for `prismaClient` that remembers every query's
 * `(modelName, args)` so a test can validate them all at the end. Only the
 * model/method pairs actually used by the finance controllers are stubbed;
 * anything else throws loudly rather than silently returning undefined.
 */
function makeRecordingPrisma(modelNames) {
  const queries = [];
  const client = {};

  for (const modelName of modelNames) {
    const camel = modelName[0].toLowerCase() + modelName.slice(1);
    client[camel] = {};
    for (const method of ['findMany', 'findFirst', 'findUnique', 'aggregate', 'count', 'groupBy', 'create', 'update', 'createMany', 'updateMany', 'delete']) {
      client[camel][method] = jest.fn(async (args) => {
        queries.push({ model: modelName, method, args });
        return method.endsWith('Many') || method === 'findMany' ? [] : null;
      });
    }
  }

  client.$transaction = jest.fn(async (fn) => (Array.isArray(fn) ? [] : fn(client)));
  client.$queryRaw = jest.fn(async () => []);

  return { client, queries };
}

/** Validate every query a `makeRecordingPrisma` client captured. */
function assertAllQueriesValid({ queries }) {
  const failures = [];
  for (const q of queries) {
    try {
      assertQueryShape(q.model, q.args, `${q.model}.${q.method}`);
    } catch (err) {
      if (err instanceof PrismaQueryShapeError) failures.push(err.message);
      else throw err;
    }
  }
  if (failures.length) {
    throw new PrismaQueryShapeError(
      'recorded queries',
      `\n  - ${failures.join('\n  - ')}`
    );
  }
}

module.exports = {
  assertQueryShape,
  assertAllQueriesValid,
  makeRecordingPrisma,
  PrismaQueryShapeError,
  hasField,
  relatedModelName,
  MODELS,
};
