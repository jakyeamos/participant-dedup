import { describe, expect, it } from "vitest";
import { normalizeDob } from "@/server/match/normalizeDob";
import { cloneDefaultConfig } from "@/shared/config";

const cfg = cloneDefaultConfig();
const tz = "America/New_York";

describe("normalizeDob", () => {
  it("parses M/D/YYYY into an ISO value and VALID state", () => {
    expect(normalizeDob("1/2/1990", tz, cfg)).toEqual({
      value: "1990-01-02",
      state: "VALID",
    });
  });

  it("parses YYYY-MM-DD directly", () => {
    expect(normalizeDob("1985-11-30", tz, cfg)).toEqual({
      value: "1985-11-30",
      state: "VALID",
    });
  });

  it("classifies 1900-01-01 as PLACEHOLDER", () => {
    expect(normalizeDob("01/01/1900", tz, cfg).state).toBe("PLACEHOLDER");
  });

  it("classifies blank as MISSING", () => {
    expect(normalizeDob("", tz, cfg).state).toBe("MISSING");
    expect(normalizeDob(null, tz, cfg).state).toBe("MISSING");
  });

  it("classifies out-of-range components as INVALID", () => {
    expect(normalizeDob("13/40/2000", tz, cfg).state).toBe("INVALID");
    expect(normalizeDob("2001-02-29", tz, cfg).state).toBe("INVALID");
  });

  it("does not accept ambiguous free-form date strings", () => {
    expect(normalizeDob("Jan 2 1990", tz, cfg).state).toBe("INVALID");
  });
});
