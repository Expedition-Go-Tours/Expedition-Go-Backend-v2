/**
 * Development-only logging. In production builds these become no-ops (Vite sets `import.meta.env.DEV` to false).
 * Use instead of raw `console.*` when diagnostics help local debugging but must not ship to users.
 */
export function devLog(...args) {
  if (import.meta.env.DEV) console.log(...args);
}

export function devWarn(...args) {
  if (import.meta.env.DEV) console.warn(...args);
}

export function devError(...args) {
  if (import.meta.env.DEV) console.error(...args);
}
