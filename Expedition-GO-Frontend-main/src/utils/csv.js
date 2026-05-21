function escapeCell(value) {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert an array of plain objects (or an array of column values) to a CSV string.
 * Pass `columns` to control the header order and labels.
 */
export function toCsv(rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const cols =
    columns ||
    Object.keys(rows[0]).map((key) => ({ key, label: key }));
  const header = cols.map((c) => escapeCell(c.label || c.key)).join(",");
  const body = rows
    .map((row) =>
      cols
        .map((c) => {
          const raw = typeof c.accessor === "function" ? c.accessor(row) : row?.[c.key];
          return escapeCell(raw);
        })
        .join(","),
    )
    .join("\n");
  return `${header}\n${body}`;
}

export function downloadCsv(filename, csv) {
  if (typeof window === "undefined") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
