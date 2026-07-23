import { describe, expect, it } from "vitest";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { resolveSchema } from "@/server/schemaResolver";
import { cloneDefaultConfig } from "@/shared/config";
import { isDedupError } from "@/server/errors";

const cfg = cloneDefaultConfig();

function gatewayWith(sheetName: string, rows: string[][]): FakeSheetsGateway {
  const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
  g.loadSheet(sheetName, { values: rows });
  return g;
}

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(isDedupError(thrown)).toBe(true);
  expect((thrown as { code: string }).code).toBe(code);
}

describe("resolveSchema", () => {
  it("finds a header row below title rows and maps canonical fields", () => {
    const g = gatewayWith("Participants", [
      ["Participant Export"],
      ["Generated 2026-07-01"],
      ["_Dedup_ID", "First Name", "Last Name", "DOB", "ZIP", "Program"],
      ["id-1", "Zanael", "Bramock", "1/2/1980", "01234", "Alpha"],
    ]);
    const schema = resolveSchema(g, "Participants", cfg);

    expect(schema.headerRow).toBe(3);
    expect(schema.columnByCanonicalField).toEqual({
      first: 1,
      last: 2,
      dob: 3,
      zip: 4,
    });
    expect(schema.dedupIdColumnIndex).toBe(0);
    expect(schema.extraColumns).toEqual([{ header: "Program", columnIndex: 5 }]);
    expect(schema.spreadsheetId).toBe("SS1");
    expect(schema.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("excludes _Dedup_ID from extra columns", () => {
    const g = gatewayWith("P", [
      ["First", "Last", "DOB", "_Dedup_ID", "Notes"],
      ["A", "B", "1/1/1980", "id-1", "hi"],
    ]);
    const schema = resolveSchema(g, "P", cfg);
    expect(schema.extraColumns).toEqual([{ header: "Notes", columnIndex: 4 }]);
    expect(schema.dedupIdColumnIndex).toBe(3);
  });

  it("throws MISSING_REQUIRED_HEADERS when Last is absent", () => {
    const g = gatewayWith("P", [["First Name", "DOB", "ZIP", "City"]]);
    expectCode(() => resolveSchema(g, "P", cfg), "MISSING_REQUIRED_HEADERS");
  });

  it("throws HEADER_AMBIGUOUS when two rows tie at the top qualifying score", () => {
    const g = gatewayWith("P", [
      ["First", "Last", "DOB", "ZIP"],
      ["some data row that matches nothing", "", "", ""],
      ["First", "Last", "DOB", "ZIP"],
    ]);
    expectCode(() => resolveSchema(g, "P", cfg), "HEADER_AMBIGUOUS");
  });

  it("throws DUPLICATE_HEADERS when a canonical field maps to two columns", () => {
    const g = gatewayWith("P", [["First", "Last", "DOB", "First"]]);
    expectCode(() => resolveSchema(g, "P", cfg), "DUPLICATE_HEADERS");
  });

  it("recognizes alias spellings (given name / surname / postal code)", () => {
    const g = gatewayWith("P", [
      ["Given Name", "Surname", "Date of Birth", "Postal Code"],
      ["A", "B", "1/1/1980", "01234"],
    ]);
    const schema = resolveSchema(g, "P", cfg);
    expect(schema.columnByCanonicalField).toEqual({
      first: 0,
      last: 1,
      dob: 2,
      zip: 3,
    });
    expect(schema.dedupIdColumnIndex).toBe(-1);
  });
});
