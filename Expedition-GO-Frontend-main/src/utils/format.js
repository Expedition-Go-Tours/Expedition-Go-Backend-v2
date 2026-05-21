import { format, formatDistanceToNow, parseISO } from "date-fns";

export function safeNumber(value, fallback = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

const currencyFormatters = new Map();
function getCurrencyFormatter(currency) {
  const code = String(currency || "USD").toUpperCase();
  if (!currencyFormatters.has(code)) {
    try {
      currencyFormatters.set(
        code,
        new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: code,
          maximumFractionDigits: 2,
        }),
      );
    } catch {
      currencyFormatters.set(code, new Intl.NumberFormat("en-US"));
    }
  }
  return currencyFormatters.get(code);
}

export function formatCurrency(value, currency = "USD") {
  const num = safeNumber(value, 0);
  return getCurrencyFormatter(currency).format(num);
}

const compactFormatter = new Intl.NumberFormat("en-US", { notation: "compact" });
export function formatCompact(value) {
  return compactFormatter.format(safeNumber(value, 0));
}

const numberFormatter = new Intl.NumberFormat("en-US");
export function formatNumber(value) {
  return numberFormatter.format(safeNumber(value, 0));
}

export function formatPercent(value, fractionDigits = 1) {
  const num = safeNumber(value, 0);
  return `${num.toFixed(fractionDigits)}%`;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    try {
      const d = parseISO(value);
      if (!Number.isNaN(d.getTime())) return d;
    } catch {
      // fallthrough
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function formatDate(value, pattern = "MMM d, yyyy") {
  const date = toDate(value);
  if (!date) return "—";
  try {
    return format(date, pattern);
  } catch {
    return "—";
  }
}

export function formatDateTime(value, pattern = "MMM d, yyyy 'at' h:mm a") {
  return formatDate(value, pattern);
}

export function formatRelative(value) {
  const date = toDate(value);
  if (!date) return "—";
  try {
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return "—";
  }
}
