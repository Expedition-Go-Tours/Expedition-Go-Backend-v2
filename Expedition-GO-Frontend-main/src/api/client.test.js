import { describe, it, expect } from "vitest";
import { ApiError, unwrap } from "@/api/client";

describe("ApiError", () => {
  it("creates error with defaults", () => {
    const error = new ApiError({ message: "Not found" });
    expect(error.message).toBe("Not found");
    expect(error.status).toBe(0);
    expect(error.data).toBeNull();
    expect(error.url).toBeNull();
  });

  it("creates error with custom status", () => {
    const error = new ApiError({ message: "Bad request", status: 400 });
    expect(error.status).toBe(400);
  });

  it("includes data payload", () => {
    const error = new ApiError({ message: "Error", data: { code: "INVALID" } });
    expect(error.data).toEqual({ code: "INVALID" });
  });

  it("is instance of Error", () => {
    const error = new ApiError({ message: "Test" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
  });
});

describe("unwrap", () => {
  it("returns non-object payload as-is", () => {
    expect(unwrap("string")).toBe("string");
    expect(unwrap(42)).toBe(42);
    expect(unwrap(null)).toBeNull();
  });

  it("extracts data field when present", () => {
    expect(unwrap({ data: { id: 1 } })).toEqual({ id: 1 });
  });

  it("extracts nested key when specified", () => {
    const payload = { data: { users: [{ id: 1 }] } };
    expect(unwrap(payload, "users")).toEqual([{ id: 1 }]);
  });

  it("returns unwrapped data when key not found in nested data", () => {
    const payload = { data: { id: 1 } };
    expect(unwrap(payload, "missing")).toEqual({ id: 1 });
  });
});
