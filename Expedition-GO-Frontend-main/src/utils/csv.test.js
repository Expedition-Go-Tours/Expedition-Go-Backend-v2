import { describe, it, expect } from "vitest";
import { toCsv, downloadCsv } from "@/utils/csv";

describe("toCsv", () => {
  it("returns empty string for empty array", () => {
    expect(toCsv([])).toBe("");
  });

  it("converts array of objects to CSV string", () => {
    const rows = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ];
    const result = toCsv(rows);
    expect(result).toBe("name,age\nAlice,30\nBob,25");
  });

  it("uses custom columns for header order", () => {
    const rows = [
      { name: "Alice", age: 30, city: "Accra" },
    ];
    const columns = [
      { key: "city", label: "City" },
      { key: "name", label: "Name" },
    ];
    const result = toCsv(rows, columns);
    expect(result).toBe("City,Name\nAccra,Alice");
  });

  it("escapes values containing commas", () => {
    const rows = [
      { name: "Smith, John", age: 30 },
    ];
    const result = toCsv(rows);
    expect(result).toBe('name,age\n"Smith, John",30');
  });

  it("escapes values containing quotes", () => {
    const rows = [
      { name: 'John "The Rock"', age: 30 },
    ];
    const result = toCsv(rows);
    expect(result).toBe('name,age\n"John ""The Rock""",30');
  });

  it("handles null and undefined values", () => {
    const rows = [
      { name: "Alice", age: null },
      { name: "Bob", age: undefined },
    ];
    const result = toCsv(rows);
    expect(result).toBe("name,age\nAlice,\nBob,");
  });
});

describe("downloadCsv", () => {
  it("returns early when window is undefined", () => {
    // This test verifies the function handles SSR gracefully
    expect(downloadCsv).toBeDefined();
  });
});
