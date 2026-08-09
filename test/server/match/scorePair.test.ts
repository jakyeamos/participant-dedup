import { describe, expect, it } from "vitest";
import { scorePair } from "@/server/match/scorePair";
import { normalizeName } from "@/server/match/normalizeName";
import { normalizeDob } from "@/server/match/normalizeDob";
import { normalizeZip } from "@/server/match/normalizeZip";
import { normalizeAddress } from "@/server/match/normalizeAddress";
import {
  normalizeCity,
  normalizeCounty,
  normalizeState,
} from "@/server/match/normalizeLocation";
import { cloneDefaultConfig } from "@/shared/config";
import type { CellValue, RecordSnapshot } from "@/server/types";

const cfg = cloneDefaultConfig();
const tz = "America/New_York";

interface Fields {
  first?: string;
  middle?: string;
  last?: string;
  dob?: CellValue;
  address?: string;
  city?: string;
  state?: string;
  county?: string;
  zip?: string;
  extras?: Record<string, string | null>;
}

function rec(id: string, f: Fields): RecordSnapshot {
  return {
    batchId: "b",
    dedupId: id,
    sourceRowAtScan: 0,
    rowFingerprint: "",
    relevantHash: "",
    rawValues: [],
    displayValues: [],
    formulas: [],
    valuesByHeader: {},
    displayByHeader: {},
    normalized: {
      name: normalizeName(f.first ?? "", f.middle ?? "", f.last ?? "", cfg),
      dob: normalizeDob(f.dob ?? null, tz, cfg),
      zip: normalizeZip(f.zip ?? ""),
      address: normalizeAddress(f.address ?? null, cfg),
      city: normalizeCity(f.city ?? null, cfg),
      state: normalizeState(f.state ?? null, cfg),
      county: normalizeCounty(f.county ?? null, cfg),
      extras: f.extras ?? {},
    },
  };
}

describe("scorePair acceptance matrix", () => {
  it("AT-01 exact duplicate -> HIGH", () => {
    const a = rec("1", { first: "John", last: "Public", dob: "1/15/1990", zip: "02118", address: "1 Main St" });
    const b = rec("2", { first: "John", last: "Public", dob: "1/15/1990", zip: "02118", address: "1 Main St" });
    const s = scorePair(a, b, cfg);
    expect(s.confidence).toBe("HIGH");
    expect(s.reasons).toContain("EXACT_NAME");
    expect(s.reasons).toContain("EXACT_DOB");
  });

  it("AT-02 first/last swapped + matching DOB -> HIGH or MEDIUM with FIRST_LAST_REVERSED", () => {
    const a = rec("1", { first: "John", last: "Public", dob: "1/15/1990" });
    const b = rec("2", { first: "Public", last: "John", dob: "1/15/1990" });
    const s = scorePair(a, b, cfg);
    expect(["HIGH", "MEDIUM"]).toContain(s.confidence);
    expect(s.reasons).toContain("FIRST_LAST_REVERSED");
  });

  it("AT-03 one-char typo + DOB + ZIP -> HIGH", () => {
    const a = rec("1", { first: "Jon", last: "Smith", dob: "3/4/1985", zip: "02118" });
    const b = rec("2", { first: "John", last: "Smith", dob: "3/4/1985", zip: "02118" });
    const s = scorePair(a, b, cfg);
    expect(s.confidence).toBe("HIGH");
  });

  it("AT-04 missing middle stays strong and flags MIDDLE_NAME_MISSING", () => {
    const a = rec("1", { first: "John", last: "Public", dob: "1/15/1990" });
    const b = rec("2", { first: "John", middle: "Quincy", last: "Public", dob: "1/15/1990" });
    const s = scorePair(a, b, cfg);
    expect(s.confidence).toBe("HIGH");
    expect(s.reasons).toContain("MIDDLE_NAME_MISSING");
  });

  it("AT-05 middle initial vs full -> MIDDLE_INITIAL_MATCH", () => {
    const a = rec("1", { first: "Amy", middle: "J", last: "Lee", dob: "5/5/1970" });
    const b = rec("2", { first: "Amy", middle: "James", last: "Lee", dob: "5/5/1970" });
    const s = scorePair(a, b, cfg);
    expect(s.reasons).toContain("MIDDLE_INITIAL_MATCH");
  });

  it("AT-06 parenthetical alias -> PARENTHETICAL_ALIAS", () => {
    const a = rec("1", { first: "Bob (Bobby)", last: "Smith", dob: "2/2/1980" });
    const b = rec("2", { first: "Bobby", last: "Smith", dob: "2/2/1980" });
    const s = scorePair(a, b, cfg);
    expect(s.reasons).toContain("PARENTHETICAL_ALIAS");
  });

  it("AT-07 placeholder DOB contributes no points but does not block HIGH when the rest matches", () => {
    const a = rec("1", {
      first: "John",
      last: "Public",
      dob: "01/01/1900",
      zip: "02118",
      address: "1 Main St",
      city: "Boston",
      state: "MA",
    });
    const b = rec("2", {
      first: "John",
      last: "Public",
      dob: "01/01/1900",
      zip: "02118",
      address: "1 Main St",
      city: "Boston",
      state: "MA",
    });
    const s = scorePair(a, b, cfg);
    expect(s.components.dobPoints).toBe(0);
    expect(s.flags.dobExact).toBe(false);
    expect(s.flags.dobConflict).toBe(false);
    expect(s.warnings).not.toContain("CONFLICTING_VALID_DOB");
    expect(s.warnings).toContain("PLACEHOLDER_DOB");
    expect(s.confidence).toBe("HIGH");
  });

  it("AT-08 conflicting valid DOBs (strong name + same ZIP) -> LOW + CONFLICTING_VALID_DOB", () => {
    const a = rec("1", { first: "John", last: "Public", dob: "1/15/1990", zip: "02118" });
    const b = rec("2", { first: "John", last: "Public", dob: "6/6/1992", zip: "02118" });
    const s = scorePair(a, b, cfg);
    expect(s.confidence).toBe("LOW");
    expect(s.warnings).toContain("CONFLICTING_VALID_DOB");
  });

  it("AT-09 strong name-only -> LOW + NAME_ONLY_MATCH", () => {
    const a = rec("1", { first: "Jonathan", last: "Public" });
    const b = rec("2", { first: "Jonathan", last: "Public" });
    const s = scorePair(a, b, cfg);
    expect(s.confidence).toBe("LOW");
    expect(s.warnings).toContain("NAME_ONLY_MATCH");
  });

  it("AT-10 different people, same address, weak names -> EXCLUDED", () => {
    const a = rec("1", { first: "John", last: "Smith", address: "1 Main St", zip: "02118" });
    const b = rec("2", { first: "Mary", last: "Jones", address: "1 Main St", zip: "02118" });
    const s = scorePair(a, b, cfg);
    expect(s.confidence).toBe("EXCLUDED");
    expect(s.eligible).toBe(false);
  });

  it("same household, different given names, placeholder DOB -> LOW + SAME_HOUSEHOLD_ONLY", () => {
    const a = rec("1", {
      first: "Nahida",
      last: "Ahmadi",
      dob: "01/01/1900",
      address: "11606 Fortune Ave",
      city: "Cleveland",
      state: "OH",
      zip: "44111",
    });
    const b = rec("2", {
      first: "Madina",
      last: "Ahmadi",
      dob: "01/01/1900",
      address: "11606 Fortune Ave",
      city: "Cleveland",
      state: "OH",
      zip: "44111",
    });
    const s = scorePair(a, b, cfg);
    expect(s.confidence).toBe("LOW");
    expect(s.warnings).toContain("SAME_HOUSEHOLD_ONLY");
    expect(s.warnings).toContain("PLACEHOLDER_DOB");
  });

  it("shared January-1 sentinel DOB does not create EXACT_DOB identity", () => {
    const a = rec("1", {
      first: "Amisi",
      last: "William",
      dob: "01/01/1978",
      city: "Cleveland",
      state: "OH",
    });
    const b = rec("2", {
      first: "Eliza",
      last: "Amuri",
      dob: "01/01/1978",
      city: "Cleveland",
      state: "OH",
    });
    const s = scorePair(a, b, cfg);
    expect(s.flags.dobExact).toBe(false);
    expect(s.components.dobPoints).toBe(0);
    expect(s.warnings).toContain("PLACEHOLDER_DOB");
    expect(["LOW", "EXCLUDED"]).toContain(s.confidence);
  });

  it("Mohamed/Mohammad with different lasts stay out of HIGH/MEDIUM", () => {
    const a = rec("1", {
      first: "Mohamed",
      last: "Mohamed",
      dob: "01/01/1900",
      address: "3316 W 111th St",
      city: "Cleveland",
      state: "OH",
      zip: "44111",
    });
    const b = rec("2", {
      first: "Mohammad",
      last: "Mohammadi",
      dob: "07/25/2009",
      address: "2086 W 89",
      city: "Cleveland",
      state: "OH",
    });
    const s = scorePair(a, b, cfg);
    expect(["LOW", "EXCLUDED"]).toContain(s.confidence);
  });

  it("Abdul* household variants at one address are LOW without matching DOB", () => {
    const a = rec("1", {
      first: "Abdul Wahid",
      last: "Ibrahimi",
      dob: "01/01/1978",
      address: "9235 North Church Drive",
      city: "Parma Heights",
      state: "OH",
      zip: "44130",
    });
    const b = rec("2", {
      first: "Abdul Wodod",
      last: "Ibrahimi",
      dob: "06/01/2005",
      address: "9235 North Church Drive",
      city: "Parma Heights",
      state: "OH",
      zip: "44130",
    });
    const s = scorePair(a, b, cfg);
    expect(["LOW", "EXCLUDED"]).toContain(s.confidence);
  });

  it("shared real DOB with unrelated names is not MEDIUM/HIGH", () => {
    const a = rec("1", {
      first: "Penina",
      last: "Faraja",
      dob: "01/05/2010",
      city: "Cleveland",
      state: "OH",
    });
    const b = rec("2", {
      first: "Ketia",
      last: "Chikura",
      dob: "01/05/2010",
      city: "Cleveland",
      state: "OH",
    });
    const s = scorePair(a, b, cfg);
    expect(["LOW", "EXCLUDED"]).toContain(s.confidence);
  });

  it("weak Amisa/Amina-style MEDIUM links across different lasts are capped", () => {
    const a = rec("1", {
      first: "Amisa",
      last: "Mfawume",
      address: "3780 West 130th Street",
      city: "Cleveland",
      state: "OH",
      zip: "44111",
    });
    const b = rec("2", {
      first: "Amina",
      last: "Unknown",
      dob: "01/01/1900",
      address: "3262 West 129th Street",
      city: "Cleveland",
      state: "OH",
    });
    const s = scorePair(a, b, cfg);
    expect(["LOW", "EXCLUDED"]).toContain(s.confidence);
  });

  it("Ali Mohammad Ali vs Ali Ahmad Ali at related addresses stay out of core bands", () => {
    const a = rec("1", {
      first: "Ali Mohammad",
      last: "Ali",
      dob: "01/01/1900",
      address: "3371 West 119th Street",
      city: "Cleveland",
      state: "OH",
      zip: "44111",
    });
    const b = rec("2", {
      first: "Ali Ahmad",
      last: "Ali",
      dob: "03/31/2005",
      address: "3371 West 119th Street",
      city: "Cleveland",
      state: "OH",
      zip: "44111",
    });
    const s = scorePair(a, b, cfg);
    expect(["LOW", "EXCLUDED"]).toContain(s.confidence);
  });

  it("blank last name cannot hub-merge Mohamed variants", () => {
    const a = rec("1", {
      first: "Mohamed",
      last: "Mohamed",
      dob: "01/01/1900",
      address: "3316 W 111th St",
      city: "Cleveland",
      state: "OH",
      zip: "44111",
    });
    const b = rec("2", {
      first: "Mohamad",
      last: "Unknown",
      dob: "01/01/1900",
      address: "3262 West 129th Street",
      city: "Cleveland",
      state: "OH",
    });
    const s = scorePair(a, b, cfg);
    expect(["LOW", "EXCLUDED"]).toContain(s.confidence);
  });

  it("shared birthday with unrelated name is not eligible (Alina vs Hadji case)", () => {
    const a = rec("1", {
      first: "Alina",
      last: "Mykhailytsia",
      dob: "04/15/2006",
      address: "3710 Oak Park Avenue",
      city: "Cleveland",
      state: "OH",
      zip: "44109",
    });
    const b = rec("2", {
      first: "Hadji",
      last: "Rama",
      dob: "04/15/2006",
      address: "6516 Clark Avenue",
      city: "Cleveland",
      state: "OH",
      zip: "44102",
    });
    const s = scorePair(a, b, cfg);
    expect(s.eligible).toBe(false);
    expect(s.confidence).toBe("EXCLUDED");
  });

  it("true first/last reversal with matching DOB stays HIGH", () => {
    const a = rec("1", {
      first: "Hadji",
      last: "Rama",
      dob: "04/15/2006",
      address: "6516 Clark Avenue",
      city: "Cleveland",
      state: "OH",
      zip: "44102",
    });
    const b = rec("2", {
      first: "Rama",
      last: "Hadji",
      dob: "04/15/2006",
      address: "6516 Clark Ave",
      city: "Cleveland",
      state: "OH",
      zip: "44102",
    });
    const s = scorePair(a, b, cfg);
    expect(s.confidence).toBe("HIGH");
    expect(s.reasons).toContain("FIRST_LAST_REVERSED");
  });

  it("same household, same given name, placeholder DOB -> still HIGH (AT-07 shape)", () => {
    const a = rec("1", {
      first: "Madina",
      last: "Ahmadi",
      dob: "01/01/1900",
      address: "11606 Fortune Ave",
      city: "Cleveland",
      state: "OH",
      zip: "44111",
    });
    const b = rec("2", {
      first: "Madina",
      last: "Ahmadi",
      dob: "01/01/1900",
      address: "11606 Fortune Ave",
      city: "Cleveland",
      state: "OH",
      zip: "44111",
    });
    const s = scorePair(a, b, cfg);
    expect(s.confidence).toBe("HIGH");
  });

  it("AT-11 same person moved (name + DOB match, ZIP/address differ) -> eligible", () => {
    const a = rec("1", { first: "John", last: "Public", dob: "1/15/1990", zip: "02118", address: "1 Main St" });
    const b = rec("2", { first: "John", last: "Public", dob: "1/15/1990", zip: "99001", address: "5 Oak Ave" });
    const s = scorePair(a, b, cfg);
    expect(s.eligible).toBe(true);
    expect(s.confidence).not.toBe("EXCLUDED");
    expect(s.warnings).toContain("DIFFERENT_ZIP");
  });

  it("produces sorted, de-duplicated reason and warning arrays", () => {
    const a = rec("1", { first: "John", last: "Public", dob: "1/15/1990", zip: "02118" });
    const b = rec("2", { first: "John", last: "Public", dob: "1/15/1990", zip: "02118" });
    const s = scorePair(a, b, cfg);
    expect(s.reasons).toEqual([...new Set(s.reasons)].sort());
    expect(s.warnings).toEqual([...new Set(s.warnings)].sort());
  });
});
