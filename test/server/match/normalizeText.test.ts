import { describe, expect, it } from "vitest";
import { normalizeText } from "@/server/match/normalizeText";
import {
  normalizeCity,
  normalizeCounty,
  normalizeState,
} from "@/server/match/normalizeLocation";
import { cloneDefaultConfig } from "@/shared/config";

const cfg = cloneDefaultConfig();

describe("normalizeText", () => {
  it("strips diacritics, lowercases, trims", () => {
    expect(normalizeText("  Café ", cfg)).toBe("cafe");
    expect(normalizeText("JOSÉ", cfg)).toBe("jose");
  });

  it("maps null-like and configured missing labels to null", () => {
    expect(normalizeText(null, cfg)).toBeNull();
    expect(normalizeText("N/A", cfg)).toBeNull();
    expect(normalizeText("  Unknown ", cfg)).toBeNull();
    expect(normalizeText("", cfg)).toBeNull();
  });

  it("collapses internal whitespace and comparison punctuation", () => {
    expect(normalizeText("Smith,   Jr.", cfg)).toBe("smith jr");
  });

  it("preserves apostrophes and hyphens in canonical form", () => {
    expect(normalizeText("O’Brien", cfg)).toBe("o'brien");
    expect(normalizeText("Smith–Jones", cfg)).toBe("smith-jones");
  });

  it("coerces numbers to their string form", () => {
    expect(normalizeText(12345, cfg)).toBe("12345");
  });
});

describe("normalizeState / normalizeCity / normalizeCounty", () => {
  it("maps full state names to two-letter codes", () => {
    expect(normalizeState("California", cfg)).toBe("ca");
    expect(normalizeState("new york", cfg)).toBe("ny");
  });

  it("passes through existing two-letter codes", () => {
    expect(normalizeState("CA", cfg)).toBe("ca");
  });

  it("normalizes city with general text rules", () => {
    expect(normalizeCity("  Saint Louis ", cfg)).toBe("saint louis");
  });

  it("drops a trailing standalone 'county' word", () => {
    expect(normalizeCounty("Kings County", cfg)).toBe("kings");
    expect(normalizeCounty("kings", cfg)).toBe("kings");
  });
});
