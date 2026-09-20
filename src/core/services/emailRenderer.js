/**
 * Email Template Renderer — resolves the Handlebars-style placeholders used by
 * the compiled transactional templates in sendgrid-templates/generated/.
 *
 * Supported syntax:
 *   {{varName}}                          simple substitution
 *   {{#if varName}}...{{else}}...{{/if}}  conditional block (nested supported)
 *   {{#each items}}...{{/each}}           iteration; inside the loop {{this}},
 *                                         {{label}}, {{previous}}, {{updated}}
 *                                         resolve against the current item.
 *
 * Unknown variables render as an empty string. A `{{#if}}` block renders its
 * body only when the variable is truthy (non-empty string, non-zero number,
 * true, or a non-empty array/object). `{{#each}}` over a missing or empty
 * value renders nothing.
 *
 * @author Tour Platform Team
 */

const TOKEN_RE = /\{\{([#/]?)([\s\S]*?)\}\}/;

/**
 * Parse template source into a node tree, then evaluate it against `data`.
 * Pure function — no global state, safe for concurrent sends.
 */
function render(source, data = {}) {
  const tree = parse(source);
  return evaluate(tree, data, {});
}

function parse(source) {
  const root = [];
  const stack = [{ children: root, type: 'root' }];
  let cursor = 0;

  while (cursor < source.length) {
    const match = TOKEN_RE.exec(source.slice(cursor));
    if (!match) {
      stack[stack.length - 1].children.push({ type: 'text', text: source.slice(cursor) });
      break;
    }

    const tokenStart = cursor + match.index;
    const literal = source.slice(cursor, tokenStart);
    if (literal) stack[stack.length - 1].children.push({ type: 'text', text: literal });

    const [full, prefix, exprRaw] = match;
    const expr = exprRaw.trim();
    cursor = tokenStart + full.length;

    if (prefix === '#') {
      if (expr.startsWith('if ')) {
        const varName = expr.slice(3).trim();
        const node = { type: 'if', varName, branches: [] };
        stack[stack.length - 1].children.push(node);
        stack.push({ children: [], type: 'branch', parent: node });
      } else if (expr.startsWith('each ')) {
        const varName = expr.slice(5).trim();
        const node = { type: 'each', varName };
        stack[stack.length - 1].children.push(node);
        stack.push({ children: [], type: 'eachBody', parent: node });
      } else {
        throw new Error(`Unsupported block opener: {{#${expr}}}`);
      }
    } else if (prefix === '/') {
      const closing = stack.pop();
      const expected = expr.trim();
      const actual = closing.type === 'branch' ? 'if' : closing.type === 'eachBody' ? 'each' : closing.type;
      if (expected !== actual) {
        throw new Error(`Mismatched closing tag {{/${expr}}}; expected {{/${actual}}}`);
      }
      if (closing.type === 'branch') {
        closing.parent.branches.push(closing.children);
      } else if (closing.type === 'eachBody') {
        closing.parent.body = closing.children;
      }
    } else if (expr === 'else') {
      const top = stack[stack.length - 1];
      if (top.type !== 'branch') throw new Error('{{else}} outside {{#if}} block');
      top.parent.branches.push([]);
      top.children = [];
    } else {
      stack[stack.length - 1].children.push({ type: 'var', name: expr });
    }
  }

  if (stack.length !== 1) throw new Error('Unclosed {{#if}} or {{#each}} block in template');
  return root;
}

function evaluate(nodes, scope, context) {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.text;
        break;
      case 'var': {
        const val = resolve(node.name, scope, context);
        out += val === null || val === undefined ? '' : String(val);
        break;
      }
      case 'if': {
        const truthy = isTruthy(resolve(node.varName, scope, context));
        const branch = node.branches[truthy ? 0 : 1];
        if (branch) out += evaluate(branch, scope, context);
        break;
      }
      case 'each': {
        const items = resolve(node.varName, scope, context);
        if (Array.isArray(items)) {
          for (const item of items) out += evaluate(node.body, item, { ...context });
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function resolve(name, scope, context) {
  if (name === 'this') return scope;
  if (name === '@index') return context.index;
  if (typeof scope === 'object' && scope !== null && name in scope) return scope[name];
  return undefined;
}

function isTruthy(val) {
  if (val === null || val === undefined) return false;
  if (typeof val === 'string') return val.length > 0;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'boolean') return val;
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

module.exports = { render };
