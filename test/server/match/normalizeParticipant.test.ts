import { describe, expect, it } from "vitest";
import { normalizeParticipant } from "@/server/match/normalizeParticipant";
import { cloneDefaultConfig } from "@/shared/config";
import type { CellValue, SourceSchema } from "@/server/types";

const cfg = cloneDefaultConfig();
const tz = "America/New_York";

const headers = [
  "First Name",
  "Middle",
  "Last Name",
  "DOB",
  "Address",
  "City",
  "State",
  "County",
  "Zip",
  "Notes",
];

const schema: SourceSchema = {
  spreadsheetId: "SHEET",
  sheetId: 0,
  sheetName: "Participants",
  headerRow: 1,
  headers,
  normalizedHeaders: headers.map((h) => h.toLowerCase()),
  columnByCanonicalField: {
    first: 0,
    middle: 1,
    last: 2,
    dob: 3,
    address1: 4,
    city: 5,
    state: 6,
    county: 7,
    zip: 8,
  },
  extraColumns: [{ header: "Notes", columnIndex: 9 }],
  dedupIdColumnIndex: 10,
  schemaHash: "hash",
};

function row(
  values: Record<string, CellValue>,
  display: Record<string, string>,
) {
  return normalizeParticipant(values, display, schema, tz, cfg);
}

describe("normalizeParticipant", () => {
  it("assembles every canonical field through the correct normalizer", () => {
    const p = row(
      {
        "First Name": "John",
        Middle: "Q",
        "Last Name": "Public",
        DOB: "1/2/1990",
        Address: "123 North Main Street Apt 4",
        City: "Boston",
        State: "Massachusetts",
        County: "Suffolk County",
        Zip: 1720,
        Notes: "VIP",
      },
      { Zip: "01720" },
    );
    expect(p.name.coreTokens).toEqual(["john", "public"]);
    expect(p.dob).toEqual({ value: "1990-01-02", state: "VALID" });
    expect(p.address!.houseNumber).toBe("123");
    expect(p.city).toBe("boston");
    expect(p.state).toBe("ma");
    expect(p.county).toBe("suffolk");
  });

  it("preserves leading-zero ZIPs by reading the display value", () => {
    const p = row(
      { "First Name": "A", "Last Name": "B", Zip: 1720 },
      { Zip: "01720" },
    );
    expect(p.zip).toBe("01720");
  });

  it("normalizes extra columns as general text keyed by header", () => {
    const p = row(
      { "First Name": "A", "Last Name": "B", Notes: "  Follow-Up  " },
      {},
    );
    expect(p.extras).toHaveProperty("Notes", "follow-up");
  });

  it("yields null field values when a header is absent from the row", () => {
    const p = row({ "First Name": "A", "Last Name": "B" }, {});
    expect(p.dob.state).toBe("MISSING");
    expect(p.zip).toBeNull();
    expect(p.address).toBeNull();
    expect(p.city).toBeNull();
  });
});
