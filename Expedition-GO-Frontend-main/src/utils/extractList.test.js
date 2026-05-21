import { describe, it, expect } from "vitest";
import { extractList, extractScalar } from "@/utils/extractList";

describe("extractList", () => {
  it("returns array payload as-is", () => {
    const arr = [{ id: 1 }, { id: 2 }];
    expect(extractList(arr)).toBe(arr);
  });

  it("extracts from { data: [...] }", () => {
    const payload = { data: [{ id: 1 }, { id: 2 }] };
    expect(extractList(payload)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("extracts from { items: [...] }", () => {
    const payload = { items: ["a", "b"] };
    expect(extractList(payload)).toEqual(["a", "b"]);
  });

  it("extracts from nested { data: { users: [...] } }", () => {
    const payload = { data: { users: [{ id: 1 }] } };
    expect(extractList(payload)).toEqual([{ id: 1 }]);
  });

  it("wraps single object in array", () => {
    const payload = { data: { tour: { id: 1 } } };
    expect(extractList(payload)).toEqual([{ id: 1 }]);
  });

  it("returns empty array for null/undefined", () => {
    expect(extractList(null)).toEqual([]);
    expect(extractList(undefined)).toEqual([]);
  });

  it("returns empty array for non-object", () => {
    expect(extractList("string")).toEqual([]);
    expect(extractList(42)).toEqual([]);
  });

  it("respects explicit keys", () => {
    const payload = { custom: [{ id: 1 }], data: [{ id: 2 }] };
    expect(extractList(payload, ["custom"])).toEqual([{ id: 1 }]);
  });
});

describe("extractScalar", () => {
  it("extracts scalar from top level", () => {
    expect(extractScalar({ total: 42 }, ["total"])).toBe(42);
  });

  it("extracts scalar from data nesting", () => {
    expect(extractScalar({ data: { count: 10 } }, ["count"])).toBe(10);
  });

  it("returns fallback when key not found", () => {
    expect(extractScalar({ other: "x" }, ["missing"], "default")).toBe("default");
  });

  it("returns null fallback by default", () => {
    expect(extractScalar({}, ["missing"])).toBeNull();
  });
});
