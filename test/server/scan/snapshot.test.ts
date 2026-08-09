import { describe, expect, it } from "vitest";
import { buildSnapshots } from "@/server/scan/snapshot";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import type { SourceSchema } from "@/server/types";
import { cloneDefaultConfig } from "@/shared/config";

const HEADERS = ["_Dedup_ID", "First Name", "Last Name", "DOB", "ZIP"];

const schema: SourceSchema = {
  spreadsheetId: "SHEET",
  sheetId: 0,
  sheetName: "Participants",
  headerRow: 1,
  headers: HEADERS,
  normalizedHeaders: HEADERS.map((header) => header.toLowerCase()),
  columnByCanonicalField: { first: 1, last: 2, dob: 3, zip: 4 },
  extraColumns: [],
  dedupIdColumnIndex: 0,
  schemaHash: "hash",
};

describe("snapshot ID integrity", () => {
  it("fails closed when source ID assignment did not stick", () => {
    const gateway = new FakeSheetsGateway({
      spreadsheetId: "SHEET",
      activeUserEmail: "test@example.com",
    });
    gateway.loadSheet("Participants", {
      values: [HEADERS, ["", "Ann", "Lee", "1/1/1980", "01234"]],
    });

    expect(() =>
      buildSnapshots(gateway, "b1", schema, cloneDefaultConfig(), "America/New_York"),
    ).toThrow(/Missing _Dedup_ID at source row 2/);
  });
});
