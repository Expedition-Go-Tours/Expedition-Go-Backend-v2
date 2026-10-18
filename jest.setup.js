process.env.NODE_ENV = process.env.NODE_ENV || 'development';
require('dotenv').config({ path: './.env' });

// `.env` points DATABASE_URL at the local *dev* database (`travio`). Several
// DB-gated tests write — `user.integration` creates users and only cleans up
// the `integration-*` ones, `regionFallback` deletes attractions — so pointed
// at dev they would mutate real development data and leave `dup-*@test.com`
// rows behind.
//
// TEST_DATABASE_URL is the override for an isolated database (see
// scripts/test-db-up.sh, which provisions `travio_test`). It is applied *after*
// dotenv so it wins over `.env`, and it has to happen here as well as in
// jest.globalSetup.js: globalSetup runs in the runner process, while this file
// runs inside every worker, and env changes made in globalSetup are not
// guaranteed to reach the workers.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
if (process.env.TEST_DIRECT_URL) {
  process.env.DIRECT_URL = process.env.TEST_DIRECT_URL;
}

// ─────────────────────────────────────────────────────────────────────────
// Raw-query fragments under Jest
//
// Production code builds dynamic SQL with `Prisma.sql`, `Prisma.raw`,
// `Prisma.join` and `Prisma.empty`, then interpolates the result into a
// tagged template:
//
//     prisma.$queryRaw`SELECT ... WHERE 1 = 1 ${maybeFilter} ${maybeOrderBy}`
//
// Outside Jest the client splices that fragment into the query text and sends
// its own values as $1, $2, … . Under Jest the splice does not happen, so the
// fragment object itself is serialised as a *parameter* and Postgres receives
// `WHERE 1 = 1 $1` with a jsonb argument — `42601 syntax error at or near
// "$1"`, or `42804 argument of WHERE must be type boolean, not type jsonb`
// when the placeholder lands where a boolean is required. The very same
// fragment passed as the sole argument (`$queryRaw(Prisma.sql\`...\`)`) is
// recognised, so the class identity is fine — only the nested-in-a-tag path
// misbehaves. A two-line script reproduces it outside the suite entirely, so
// this is a harness quirk of the Jest + Prisma 5.20 pairing and never fails
// in production, where the identical query runs green against the same
// database.
//
// The alternative — skipping every code path that builds SQL at runtime —
// would quietly drop `homepageRanking`, `admin.getOverview`,
// `admin.getAiStatus` and friends from real-DB coverage, which is precisely
// the coverage this repo is trying to build. Instead the tagged call is
// rebuilt here and handed to `$queryRawUnsafe`, which takes SQL text plus
// positional parameters and so produces exactly the query the client would
// have sent. The splice is duck-typed on `{ strings, values }` rather than
// `instanceof`, which is what makes it immune to the identity problem in the
// first place.
//
// The patch is installed on the *instance*, not `PrismaClient.prototype`:
// `prismaClient.js` caches its client on `global` so every test file in a
// worker shares one connection, and that instance can outlive the module
// registry it was built in — a prototype patch here would land on a different
// copy of the class than the one under test. The accessor is transparent: the
// value is stored exactly as before, and merely wrapped on the way in.
// Numbering has to continue across nesting: a fragment spliced into the middle
// of the query must pick up the outer query's next `$n`, not restart at `$1`
// and collide with whatever the outer query already bound.
function flattenSql(strings, values) {
  const out = { sql: '', values: [] };
  flattenInto(out, strings, values);
  return out;
}

function flattenInto(out, strings, values) {
  // Every level contributes its own first segment; the rest are interleaved
  // with the values below.
  out.sql += strings[0];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value && Array.isArray(value.strings) && Array.isArray(value.values)) {
      flattenInto(out, value.strings, value.values);
    } else {
      // A plain value becomes a positional placeholder, numbered in the order
      // it is bound — exactly what the client would have written itself.
      out.values.push(value);
      out.sql += `$${out.values.length}`;
    }
    out.sql += strings[i + 1];
  }
}

function installRawSqlFlattening(client) {
  for (const tag of ['$queryRaw', '$executeRaw']) {
    const unsafe = `${tag}Unsafe`;
    if (typeof client[tag] !== 'function' || typeof client[unsafe] !== 'function') continue;
    const original = client[tag].bind(client);
    client[tag] = function flattenedRawTag(...args) {
      // Only the tagged-template form is affected; anything else stays as-is.
      if (!Array.isArray(args[0]) || !args[0].raw) {
        return original(...args);
      }
      const { sql, values } = flattenSql(args[0], args.slice(1));
      return client[unsafe](sql, ...values);
    };
  }
  Object.defineProperty(client, '__rawSqlFlattened', {
    value: true,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

let cachedRawSqlClient;
Object.defineProperty(global, 'prisma', {
  configurable: true,
  get() {
    return cachedRawSqlClient;
  },
  set(value) {
    cachedRawSqlClient = value;
    if (value && typeof value === 'object' && !value.__rawSqlFlattened) {
      installRawSqlFlattening(value);
    }
  },
});
