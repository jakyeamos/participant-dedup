import { describe, expect, it } from "vitest";
import { normalizeName } from "@/server/match/normalizeName";
import { cloneDefaultConfig } from "@/shared/config";

const cfg = cloneDefaultConfig();

describe("normalizeName", () => {
  it("extracts parenthetical aliases while retaining core name text", () => {
    const n = normalizeName("Bob (Bobby)", "", "Smith", cfg);
    expect(n.firstTokens).toEqual(["bob"]);
    expect(n.aliasTokens).toContain("bobby");
    expect(n.coreTokens).toEqual(["bob", "smith"]);
  });

  it("splits hyphenated last names into multiple tokens", () => {
    const n = normalizeName("Ana", "", "Smith-Jones", cfg);
    expect(n.lastTokens).toEqual(["smith", "jones"]);
  });

  it("strips a leading standalone title from the first name", () => {
    const n = normalizeName("Dr John", "", "Roe", cfg);
    expect(n.firstTokens).toEqual(["john"]);
  });

  it("builds ordered and reversed no-middle strings", () => {
    const n = normalizeName("John", "Q", "Public", cfg);
    expect(n.orderedNoMiddle).toBe("john public");
    expect(n.reversedNoMiddle).toBe("public john");
  });

  it("produces an order-independent sorted token signature", () => {
    const a = normalizeName("John", "", "Smith", cfg);
    const b = normalizeName("Smith", "", "John", cfg);
    expect(a.sortedTokenSignature).toBe(b.sortedTokenSignature);
  });

  it("flags missingCoreComponent when the last name is blank", () => {
    const n = normalizeName("John", "", "", cfg);
    expect(n.missingCoreComponent).toBe(true);
  });

  it("retains a middle initial and full middle name as compatible tokens", () => {
    const initial = normalizeName("Amy", "J", "Lee", cfg);
    const full = normalizeName("Amy", "James", "Lee", cfg);
    expect(initial.middleTokens).toEqual(["j"]);
    expect(full.middleTokens).toEqual(["james"]);
    expect(initial.initials).toContain("j");
    expect(full.initials).toContain("j");
  });
});
