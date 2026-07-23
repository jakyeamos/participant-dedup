import { describe, expect, it } from "vitest";
import { normalizeZip } from "@/server/match/normalizeZip";

describe("normalizeZip", () => {
  it("keeps the first five digits of a ZIP+4", () => {
    expect(normalizeZip("01234-5678")).toBe("01234");
  });

  it("preserves leading zeros from the display value", () => {
    expect(normalizeZip("07030")).toBe("07030");
  });

  it("returns null for fewer than five digits", () => {
    expect(normalizeZip("123")).toBeNull();
    expect(normalizeZip("")).toBeNull();
  });

  it("strips non-digit characters before measuring length", () => {
    expect(normalizeZip("k1 2a3 4b5")).toBe("12345");
  });
});
