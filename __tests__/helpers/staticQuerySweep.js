/**
 * Statically extracts every Prisma query in `src/` and validates it against the
 * real schema, without running any of it.
 *
 * Why this exists
 * ---------------
 * __tests__/helpers/prismaQueryGuard.js validates a query *after* a controller
 * runs, which means it only ever sees the handful of code paths a test drives.
 * The rest — most of `src/`, in practice — is never checked at all, and that is
 * how `imageCover` (never a field on `Tour`; it is `coverPhoto`) reached
 * production and 500'd the invoice detail and PDF endpoints for every supplier.
 *
 * This helper closes the remaining gap by reading the source instead of running
 * it. It parses each file, finds every `prisma.<model>.<method>(args)` and
 * `tx.<model>.<method>(args)` call, statically evaluates the `args` object
 * literal, and hands the result to the same DMMF validator the runtime guard
 * uses — so the two check the schema in exactly one way.
 *
 * What it can and cannot see
 * --------------------------
 * Object literals are resolved in full, including identifier spreads of
 * module-level constants (`select: { ...LISTING_SELECT, tour: TOUR_SELECT }`)
 * and `cond && { … }` / `a ? { … } : b` shapes, because both branches of a
 * conditional are a shape the code can actually build at runtime.
 *
 * Anything whose *keys* are not statically known is deliberately skipped:
 * `prisma[BRAND.listingModel].findMany(...)` and `select: buildSelect(req)`.
 * Guessing at those would produce false failures, so they are counted instead
 * and the count is ratcheted by a test — coverage may grow, never silently rot.
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const { Prisma } = require('@prisma/client');

/** Marker for "could not statically evaluate". Never reaches the validator. */
const UNRESOLVED = Symbol('unresolved');

/** Prisma model delegate methods we recognise as query calls. */
const PRISMA_METHODS = new Set([
  'findMany', 'findFirst', 'findUnique', 'findUniqueOrThrow', 'findFirstOrThrow',
  'count', 'aggregate', 'groupBy',
  'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert',
  'delete', 'deleteMany',
]);

/**
 * `prisma.invoice` → `Invoice`. Prisma's client keys are exactly the model
 * names with a lowercased first letter, and the DMMF has no two models that
 * collide under that transform — verified once, here, rather than assumed.
 */
const CAMEL_TO_MODEL = (() => {
  const map = new Map();
  for (const model of Prisma.dmmf.datamodel.models) {
    const camel = model.name[0].toLowerCase() + model.name.slice(1);
    if (map.has(camel) && map.get(camel) !== model.name) {
      throw new Error(`ambiguous client key \`${camel}\`: ${map.get(camel)} vs ${model.name}`);
    }
    map.set(camel, model.name);
  }
  return map;
})();

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
 * Collect module-level `const NAME = <expr>` bindings so identifier spreads
 * (`select: { ...LISTING_SELECT }`) can be resolved. Only top-level bindings
 * are collected on purpose: a function-local `const SELECT` shadowing a
 * module-level one would otherwise resolve to the wrong object, and the
 * handful of local constants we would gain are not worth a silent mis-read.
 */
function collectModuleConstants(program) {
  const consts = new Map();
  for (const node of program.body) {
    if (node.type !== 'VariableDeclaration') continue;
    for (const decl of node.declarations) {
      if (decl.id.type !== 'Identifier' || !decl.init) continue;
      consts.set(decl.id.name, decl.init);
    }
  }
  return consts;
}

/** Static evaluator. Returns `UNRESOLVED` whenever a shape is not knowable. */
function evaluate(node, consts) {
  if (!node) return UNRESOLVED;

  switch (node.type) {
    case 'ObjectExpression': {
      const result = {};
      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement') {
          const spread = evaluate(prop.argument, consts);
          if (spread === UNRESOLVED) continue; // keys unknown — leave what we have
          if (spread && typeof spread === 'object' && !Array.isArray(spread)) {
            Object.assign(result, spread);
          }
          continue;
        }
        if (prop.computed) continue; // `[key]: value` — key not statically known
        const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
        const value = evaluate(prop.value, consts);
        if (value !== UNRESOLVED) result[key] = value;
      }
      return result;
    }

    case 'ArrayExpression': {
      const result = [];
      for (const el of node.elements) {
        const value = evaluate(el, consts);
        if (value !== UNRESOLVED) result.push(value);
      }
      return result;
    }

    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return node.value;

    case 'NullLiteral':
      return null;

    case 'TemplateLiteral':
      // Only a template with no substitutions is a statically known string.
      return node.expressions.length === 0
        ? node.quasis.map((q) => q.value.cooked).join('')
        : UNRESOLVED;

    case 'Identifier': {
      if (node.name === 'true') return true;
      if (node.name === 'false') return false;
      if (node.name === 'undefined') return undefined;
      if (!consts.has(node.name)) return UNRESOLVED;
      return evaluate(consts.get(node.name), consts);
    }

    case 'MemberExpression': {
      if (node.computed) return UNRESOLVED;
      const object = evaluate(node.object, consts);
      if (object === UNRESOLVED || object === null || typeof object !== 'object') {
        return UNRESOLVED;
      }
      const key = node.property.name;
      return key in object ? object[key] : UNRESOLVED;
    }

    // `cond && { … }` — the value is either `cond` or the object, so the object
    // is a real shape the code can build and must be checked.
    case 'LogicalExpression': {
      const left = evaluate(node.left, consts);
      const right = evaluate(node.right, consts);
      if (right !== UNRESOLVED && right && typeof right === 'object') return right;
      if (left !== UNRESOLVED && left && typeof left === 'object') return left;
      return UNRESOLVED;
    }

    // Same reasoning: either branch is a shape that can reach Prisma.
    case 'ConditionalExpression': {
      const consequent = evaluate(node.consequent, consts);
      const alternate = evaluate(node.alternate, consts);
      const objectish = (v) => v !== UNRESOLVED && v && typeof v === 'object';
      if (objectish(consequent)) return consequent;
      if (objectish(alternate)) return alternate;
      return UNRESOLVED;
    }

    default:
      return UNRESOLVED;
  }
}

/** Root identifier of a receiver chain (`tx` for `tx.tour`, `` for a call). */
function rootIdentifier(node) {
  let current = node;
  while (current && current.type === 'MemberExpression') current = current.object;
  return current && current.type === 'Identifier' ? current.name : '';
}

/**
 * Walk one file's AST, yielding `{ model, method, args, line, label }` for each
 * statically-resolvable Prisma call. `args` is `UNRESOLVED` when the query's
 * keys could not be determined.
 */
function extractFromSource(source, file) {
  const ast = parser.parse(source, {
    sourceType: 'script',
    errorRecovery: false,
    attachComment: false,
  });
  const consts = collectModuleConstants(ast.program);
  const found = [];

  const stack = [ast.program];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;

    if (node.type === 'CallExpression') {
      const callee = node.callee;
      if (
        callee.type === 'MemberExpression'
        && !callee.computed
        && callee.object.type === 'MemberExpression'
        && !callee.object.computed
        && callee.property.type === 'Identifier'
        && callee.object.property.type === 'Identifier'
      ) {
        const method = callee.property.name;
        const delegate = callee.object.property.name;
        const model = CAMEL_TO_MODEL.get(delegate);

        // Not a Prisma delegate (stripe.customers.update, sanity, …).
        if (model && PRISMA_METHODS.has(method)) {
          const args = node.arguments.length
            ? evaluate(node.arguments[0], consts)
            : UNRESOLVED;
          const line = node.loc ? node.loc.start.line : 0;
          found.push({
            model,
            method,
            args,
            line,
            file,
            label: `${path.relative(process.cwd(), file)}:${line} ${rootIdentifier(callee.object)}.${delegate}.${method}`,
          });
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments'
        || key === 'trailingComments' || key === 'innerComments') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === 'object' && item.type) stack.push(item);
      } else if (child && typeof child === 'object' && child.type) {
        stack.push(child);
      }
    }
  }

  return found;
}

/** Sweep every `.js` file under `srcRoot`. */
function sweepSourceTree(srcRoot) {
  const calls = [];
  const parseErrors = [];

  for (const file of listSourceFiles(srcRoot)) {
    try {
      calls.push(...extractFromSource(fs.readFileSync(file, 'utf8'), file));
    } catch (err) {
      // A file we cannot parse is one we silently cannot check, so it is
      // reported rather than swallowed.
      parseErrors.push({ file: path.relative(process.cwd(), file), message: err.message });
    }
  }

  return { calls, parseErrors };
}

module.exports = {
  UNRESOLVED,
  CAMEL_TO_MODEL,
  PRISMA_METHODS,
  listSourceFiles,
  extractFromSource,
  sweepSourceTree,
  PrismaQueryShapeError: require('./prismaQueryGuard').PrismaQueryShapeError,
};
