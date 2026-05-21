import { describe, it, expect } from "vitest";
import {
  safeNumber,
  formatCurrency,
  formatCompact,
  formatNumber,
  formatPercent,
  formatDate,
  formatDateTime,
} from "@/utils/format";

describe("safeNumber", () => {
  it("returns number as-is", () => {
    expect(safeNumber(42)).toBe(42);
  });

  it("returns fallback for NaN", () => {
    expect(safeNumber(NaN)).toBe(0);
    expect(safeNumber(NaN, -1)).toBe(-1);
  });

  it("parses numeric strings", () => {
    expect(safeNumber("3.14")).toBe(3.14);
  });

  it("returns fallback for non-numeric strings", () => {
    expect(safeNumber("abc")).toBe(0);
  });

  it("returns fallback for null/undefined", () => {
    expect(safeNumber(null)).toBe(0);
    expect(safeNumber(undefined)).toBe(0);
  });
});

describe("formatCurrency", () => {
  it("formats USD by default", () => {
    expect(formatCurrency(1234.5)).toContain("$");
  });

  it("handles string numbers", () => {
    expect(formatCurrency("99.99")).toContain("$");
  });

  it("returns $0.00 for invalid input", () => {
    expect(formatCurrency(null)).toBe("$0.00");
  });
});

describe("formatCompact", () => {
  it("compacts large numbers", () => {
    expect(formatCompact(1500000)).toMatch(/1\.?5?M/);
  });

  it("handles small numbers", () => {
    expect(formatCompact(500)).toBe("500");
  });
});

describe("formatNumber", () => {
  it("adds thousand separators", () => {
    expect(formatNumber(1000000)).toBe("1,000,000");
  });
});

describe("formatPercent", () => {
  it("formats with default precision", () => {
    expect(formatPercent(95.5)).toBe("95.5%");
  });

  it("respects custom precision", () => {
    expect(formatPercent(95.55, 2)).toBe("95.55%");
  });
});

describe("formatDate", () => {
  it("formats ISO strings", () => {
    expect(formatDate("2026-05-15")).toBe("May 15, 2026");
  });

  it("returns dash for invalid dates", () => {
    expect(formatDate(null)).toBe("\u2014");
    expect(formatDate("invalid")).toBe("\u2014");
  });

  it("accepts custom patterns", () => {
    expect(formatDate("2026-05-15", "yyyy-MM-dd")).toBe("2026-05-15");
  });
});

describe("formatDateTime", () => {
  it("formats with time", () => {
    const result = formatDateTime("2026-05-15T14:30:00");
    expect(result).toContain("May");
    expect(result).toContain("2026");
  });
});
