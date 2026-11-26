/**
 * Enum / emitter sync for notifications.
 *
 * Regression guard for the restaurant-claim bug: `submitClaim` enqueued
 * RESTAURANT_VENUE_CLAIM_PENDING and `resolveClaim` enqueued
 * RESTAURANT_CLAIM_UPDATE, but neither value existed in the Prisma enums, so
 * every create was rejected and the surrounding .catch() left the admin bell
 * and the claimant's bell silently empty.
 *
 * Three invariants, all derived from the real sources — no hand-kept list:
 *   1. every literal type passed to enqueueNotification / notifyAdmin in src/
 *      exists in the matching Prisma enum;
 *   2. every type in notificationCategories' map is a real NotificationType;
 *   3. every type the admin feed can show is a real AdminNotificationType.
 */

const fs = require('fs');
const path = require('path');

const { CATEGORY_BY_TYPE } = require('../../src/core/services/notificationCategories');
const { NOTIFICATION_TYPES_BY_CATEGORY } = require('../../config/permissions');
const { ADMIN_NOTIFICATION_TYPES } = require('../../src/core/domain/adminNotificationController');

const ROOT = path.join(__dirname, '..', '..');
const schema = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');

/** Enum values declared on `enum X { ... }`, ignoring comments and blanks. */
function enumValues(enumName) {
  const start = schema.indexOf(`enum ${enumName} {`);
  expect(start).toBeGreaterThan(-1);
  const body = schema.slice(start, schema.indexOf('\n}', start));
  const values = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('///')) continue;
    const m = trimmed.match(/^([A-Z][A-Z0-9_]*)/);
    if (m) values.push(m[1]);
  }
  return values;
}

/** Every .js file under src/ (skipping tests and node_modules). */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}

/**
 * Literal `type: 'VALUE'` passed to a notification emitter, per call site.
 * Dynamic `type` arguments are skipped — only literals can drift from the enum.
 * Each call's text runs until the closing `})` of its options object, so a
 * later statement's `type:` can never be attributed to the wrong call.
 */
function emittedTypes(fnName) {
  const found = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    let from = 0;
    for (;;) {
      const idx = text.indexOf(`${fnName}(`, from);
      if (idx === -1) break;
      from = idx + fnName.length;
      const end = text.indexOf('\n', text.indexOf('})', idx));
      const window = text.slice(idx, end === -1 ? idx + 900 : end);
      const literal = window.match(/type:\s*'([A-Z][A-Z0-9_]*)'/);
      if (literal) found.push({ file: path.relative(ROOT, file), type: literal[1] });
    }
  }
  return found;
}

const NOTIFICATION_ENUM = new Set(enumValues('NotificationType'));
const ADMIN_ENUM = new Set(enumValues('AdminNotificationType'));

describe('notification enums match their producers', () => {
  it('every user-notification literal is a NotificationType value', () => {
    const emitted = emittedTypes('enqueueNotification');
    expect(emitted.length).toBeGreaterThan(5);
    const invalid = emitted.filter((e) => !NOTIFICATION_ENUM.has(e.type));
    expect(invalid).toEqual([]);
  });

  it('every admin-notification literal is an AdminNotificationType value', () => {
    const emitted = emittedTypes('notifyAdmin');
    expect(emitted.length).toBeGreaterThan(3);
    const invalid = emitted.filter((e) => !ADMIN_ENUM.has(e.type));
    expect(invalid).toEqual([]);
  });

  it('notificationCategories only names real NotificationType values', () => {
    const invalid = Object.keys(CATEGORY_BY_TYPE).filter((t) => !NOTIFICATION_ENUM.has(t));
    expect(invalid).toEqual([]);
  });

  it('notificationTypesForCategories only names real NotificationType values', () => {
    const invalid = Object.values(NOTIFICATION_TYPES_BY_CATEGORY)
      .flat()
      .filter((t) => !NOTIFICATION_ENUM.has(t));
    expect(invalid).toEqual([]);
  });

  it('the admin feed allowlist only names real AdminNotificationType values', () => {
    const invalid = ADMIN_NOTIFICATION_TYPES.filter((t) => !ADMIN_ENUM.has(t));
    expect(invalid).toEqual([]);
  });

  it('carries the restaurant-claim pair end to end', () => {
    expect(NOTIFICATION_ENUM.has('RESTAURANT_CLAIM_UPDATE')).toBe(true);
    expect(ADMIN_ENUM.has('RESTAURANT_VENUE_CLAIM_PENDING')).toBe(true);
    expect(
      emittedTypes('enqueueNotification').some((e) => e.type === 'RESTAURANT_CLAIM_UPDATE'),
    ).toBe(true);
    expect(
      emittedTypes('notifyAdmin').some((e) => e.type === 'RESTAURANT_VENUE_CLAIM_PENDING'),
    ).toBe(true);
  });
});
