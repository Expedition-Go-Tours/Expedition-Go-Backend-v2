/**
 * Statically validates the raw SQL in `src/` against the real schema.
 *
 * Why this exists
 * ---------------
 * staticQuerySweep.js checks every `prisma.<model>.<method>(…)` call, but it
 * structurally cannot see raw SQL: `prisma.$queryRaw` and `$queryRawUnsafe`
 * take a string, not an args object, so the DMMF validator has nothing to walk.
 * A typo'd column there is the *same* bug class as `imageCover` — a 500 from
 * Postgres instead of from Prisma — and 93 raw sites had no coverage at all.
 *
 * The trap that makes this non-trivial
 * ------------------------------------
 * Raw SQL names **database columns**, Prisma names **fields**, and `@map`
 * splits the two: `Booking.grossAmount` is `total` in Postgres,
 * `platformCommission` is `commissionAmount`. Validating against Prisma field
 * names would false-positive on all 7 mapped columns and miss real ones, so
 * this checks `dbName` — the column as Postgres actually sees it.
 *
 * What it accepts
 * ---------------
 * An identifier is fine if it is a model name, a column name (`dbName`) or a
 * Prisma field name anywhere in the schema, an `AS "alias"` defined in the
 * same statement, a CTE name, or a `::"Type"` cast target.
 *
 * That is deliberately a *permissive* check, and the reason it ships: a strict
 * per-table check would have to resolve aliases (`FROM "User" u`, `u."name"`)
 * well enough to prove the column exists on that specific table, and every
 * false positive it produced would train people to ignore it. This catches the
 * bug that actually shipped — a column that exists nowhere — with none of that
 * noise. What it cannot catch (a real column used against the wrong table) is
 * stated in the test rather than left implicit.
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const { Prisma } = require('@prisma/client');

/** Every model name, e.g. `Tour`. */
const MODEL_NAMES = new Set(Prisma.dmmf.datamodel.models.map((m) => m.name));

/**
 * Column names as Postgres sees them (`dbName`, falling back to the field
 * name) and Prisma field names. Both are accepted because raw SQL in this
 * codebase uses each — mapped columns by their DB name, unmapped ones
 * identically either way.
 */
const COLUMN_NAMES = new Set();
const FIELD_NAMES = new Set();
for (const model of Prisma.dmmf.datamodel.models) {
  for (const field of model.fields) {
    COLUMN_NAMES.add(field.dbName || field.name);
    FIELD_NAMES.add(field.name);
  }
}

/** `"ident"` — double-quoted, the only form Postgres treats case-sensitively. */
const QUOTED_IDENT = /"([A-Za-z_][A-Za-z0-9_]*)"/g;

/** `AS "alias"` — an output column name, not a schema identifier. */
const AS_ALIAS = /\bAS\s+"([A-Za-z_][A-Za-z0-9_]*)"/gi;

/** `WITH name AS (…)` / `, name AS (…)` — a CTE defines a local relation. */
const CTE_NAME = /(?:\bWITH\s+(?:RECURSIVE\s+)?|,\s*)([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi;

/** `::"TypeName"` / `::type` — a cast target, not a column. */
const CAST_TARGET = /::\s*(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/g;

/** Recursively list every `.js` file under `dir`. */
function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Pull the SQL text out of a raw call's first argument.
 * Returns `null` when the SQL is built dynamically and cannot be checked.
 */
function sqlFromArgument(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral') {
    // Substitutions become a placeholder so `t."x" = $1` keeps its shape.
    return node.expressions.length
      ? node.quasis.map((q) => q.value.raw).join(' $1 ')
      : node.quasis.map((q) => q.value.raw).join('');
  }
  // `sql`…`, queryUnsafe(sql, …)` — anything else is not statically readable.
  return null;
}

/**
 * Validate one SQL statement.
 * Returns `{ unknown: string[] }` — identifiers that appear nowhere in the
 * schema, are not aliases, and are not cast targets.
 */
function checkSql(sql) {
  const local = new Set();

  // Statement-local names must be collected before the identifier pass,
  // otherwise an alias would be reported by the very query that defines it.
  for (const re of [AS_ALIAS, CTE_NAME, CAST_TARGET]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(sql))) local.add(m[1] || m[2]);
  }

  const unknown = new Set();
  QUOTED_IDENT.lastIndex = 0;
  let m;
  while ((m = QUOTED_IDENT.exec(sql))) {
    const ident = m[1];
    if (MODEL_NAMES.has(ident)) continue;
    if (COLUMN_NAMES.has(ident)) continue;
    if (FIELD_NAMES.has(ident)) continue;
    if (local.has(ident)) continue;
    unknown.add(ident);
  }

  return { unknown: [...unknown] };
}

/**
 * Extract every raw SQL statement from a source string.
 * Each entry carries the file-relative label and line for readable failures.
 */
function extractRawSql(source, file) {
  const ast = parser.parse(source, { sourceType: 'script' });
  const statements = [];

  const isRawCall = (member) => member && member.type === 'MemberExpression'
    && member.property
    && (member.property.name === '$queryRaw'
      || member.property.name === '$queryRawUnsafe'
      || member.property.name === '$executeRaw'
      || member.property.name === '$executeRawUnsafe');

  const stack = [ast.program];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;

    const line = node.loc ? node.loc.start.line : 0;
    const label = `${path.relative(process.cwd(), file)}:${line}`;

    // prisma.$queryRaw`SELECT …`
    if (node.type === 'TaggedTemplateExpression' && isRawCall(node.tag)) {
      const sql = node.quasi.quasis.map((q) => q.value.raw).join(' $1 ');
      statements.push({ sql, label, line, file });
    }

    // prisma.$queryRawUnsafe(`SELECT …`, a, b) / prisma.$executeRaw(sql)
    if (node.type === 'CallExpression' && isRawCall(node.callee) && node.arguments.length) {
      const sql = sqlFromArgument(node.arguments[0]);
      // Tagged-template form is handled above; only record the call form here.
      if (sql !== null && node.callee.type === 'MemberExpression') {
        statements.push({ sql, label, line, file });
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end'
        || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === 'object' && item.type) stack.push(item);
      } else if (child && typeof child === 'object' && child.type) {
        stack.push(child);
      }
    }
  }

  return statements;
}

/** Words that may legally follow a table name and are never an alias. */
const SQL_KEYWORDS = new Set([
  'where', 'set', 'order', 'group', 'limit', 'offset', 'on', 'and', 'or', 'as',
  'inner', 'left', 'right', 'outer', 'full', 'cross', 'join', 'using', 'when',
  'then', 'else', 'end', 'select', 'values', 'returning', 'union', 'except',
  'intersect', 'for', 'into', 'only', 'lateral', 'window', 'partition',
]);

/** Model name → the set of column names Postgres knows for it. */
const MODEL_COLUMNS = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [
    m.name,
    new Set(m.fields.map((f) => f.dbName || f.name)),
  ])
);

/**
 * Per-table check, layered on top of `checkSql`.
 *
 * `checkSql` asks "does this column exist anywhere in the schema", which is
 * right for catching a typo but blind to a real column used against the wrong
 * table. This asks the stronger question for the subset it can answer: it
 * resolves `FROM "Tour" t` / `JOIN "User" u` into an alias→model map, then
 * checks `t."someColumn"` against `Tour` specifically.
 *
 * Aliases it cannot resolve (subquery scopes, CTEs) are skipped rather than
 * guessed at — an unresolvable alias reported as a failure would be a false
 * positive, and one false positive is all it takes for a check like this to be
 * trained out of existence.
 *
 * Returns `{ unknown, validated, skipped }` so a test can assert on reach as
 * well as correctness — a check that silently validates nothing would otherwise
 * look identical to one that validates everything.
 */
function checkSqlPerTable(sql) {
  const aliasToModel = new Map();
  const cteNames = new Set();

  // `FROM "Tour" t` / `JOIN "User" AS u`. An unquoted table is a CTE
  // reference, not a model, so it is recorded and then skipped.
  const FROM_OR_JOIN = /\b(?:FROM|JOIN)\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/g;
  let m;
  while ((m = FROM_OR_JOIN.exec(sql))) {
    const quoted = m[1];
    const bare = m[2];
    const alias = m[3];

    if (quoted && MODEL_NAMES.has(quoted)) {
      // A bare word after the table is the alias, unless it is a keyword —
      // `FROM "Tour" WHERE …` parses as alias `WHERE` without this.
      if (alias && !SQL_KEYWORDS.has(alias.toLowerCase())) aliasToModel.set(alias, quoted);
      continue;
    }
    if (bare) cteNames.add(bare);
  }

  const unknown = [];
  let validated = 0;
  let skipped = 0;

  // `t."column"` — the qualifier is an alias resolved above.
  const QUALIFIED = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
  while ((m = QUALIFIED.exec(sql))) {
    const [, qualifier, column] = m;
    const model = aliasToModel.get(qualifier);

    if (!model) {
      // Subquery or CTE scope — genuinely not knowable here.
      skipped += 1;
      continue;
    }

    validated += 1;
    if (MODEL_COLUMNS.get(model)?.has(column)) continue;
    unknown.push(`${qualifier}."${column}" (not a column of ${model})`);
  }

  return { unknown, validated, skipped, cteNames: [...cteNames] };
}

/** Sweep every raw SQL statement under `srcRoot`. */
function sweepRawSql(srcRoot) {
  const statements = [];
  const parseErrors = [];

  for (const file of listSourceFiles(srcRoot)) {
    try {
      statements.push(...extractRawSql(fs.readFileSync(file, 'utf8'), file));
    } catch (err) {
      parseErrors.push({ file: path.relative(process.cwd(), file), message: err.message });
    }
  }

  return { statements, parseErrors };
}

module.exports = {
  MODEL_NAMES,
  COLUMN_NAMES,
  FIELD_NAMES,
  MODEL_COLUMNS,
  checkSql,
  checkSqlPerTable,
  extractRawSql,
  sweepRawSql,
  listSourceFiles,
};
