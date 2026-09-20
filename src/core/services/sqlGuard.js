/**
 * Read-only SQL validator for AI-generated queries.
 *
 * Used by the Discord bot `/ask` command to ensure MiMo-generated SQL
 * can never modify data or schema.
 *
 * @version 1.0.0
 */

const BLOCKED_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE',
  'GRANT', 'REVOKE', 'REPLACE', 'MERGE', 'CALL', 'EXEC', 'EXECUTE',
  'SET', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'LOAD', 'LOCK', 'UNLOCK',
  'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'ANALYZE', 'VACUUM',
];

const INJECTION_PATTERNS = [
  /INTO\s+(OUTFILE|DUMPFILE)/i,
  /INTO\s+OUTFILE/i,
  /LOAD\s+DATA/i,
  /\bpg_sleep\b/i,
  /\bpg_read_file\b/i,
  /\bpg_write_file\b/i,
  /\bDBMS_PIPE\b/i,
  /\bDBMS_LOCK\b/i,
  /\bUTL_HTTP\b/i,
  /\bxp_cmdshell\b/i,
  /\bsp_executesql\b/i,
];

/**
 * Validate that a SQL string is safe (read-only).
 *
 * @param {string} sql - The SQL to validate
 * @returns {{ ok: boolean, error?: string, safeSql?: string }}
 *   ok=true means the query is safe to execute.
 *   safeSql includes a LIMIT clause if one was missing.
 */
function validateReadOnly(sql) {
  if (!sql || typeof sql !== 'string') {
    return { ok: false, error: 'No SQL provided' };
  }

  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, error: 'Empty SQL' };

  // Must start with SELECT or WITH (CTE)
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    return { ok: false, error: 'SQL must start with SELECT or WITH (CTE)' };
  }

  // Reject multiple statements (semicolons inside the query body, not trailing)
  const withoutTrailingSemicolon = trimmed.replace(/;+\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    return { ok: false, error: 'Multiple statements are not allowed' };
  }

  // Reject SQL comments
  if (/--\s/.test(trimmed) || /\/\*.*\*\//s.test(trimmed)) {
    return { ok: false, error: 'SQL comments are not allowed' };
  }

  // Reject blocked keywords (must be word-boundary match, not substring)
  for (const kw of BLOCKED_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(trimmed)) {
      return { ok: false, error: `Keyword ${kw} is not allowed` };
    }
  }

  // Reject injection patterns
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(trimmed)) {
      return { ok: false, error: 'Disallowed pattern detected' };
    }
  }

  // Append LIMIT if not present (avoid unbounded result sets)
  let safeSql = withoutTrailingSemicolon.trim();
  if (!/\bLIMIT\s+\d+/i.test(safeSql)) {
    safeSql += ' LIMIT 100';
  }

  return { ok: true, safeSql };
}

module.exports = { validateReadOnly };
