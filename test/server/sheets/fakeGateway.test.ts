import { describe, expect, it } from "vitest";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import type { SheetsBatchUpdateRequest } from "@/server/sheets/SheetsGateway";
import { isDedupError } from "@/server/errors";

describe("FakeSheetsGateway", () => {
  it("reports spreadsheet id, time zone, and active user email", () => {
    const g = new FakeSheetsGateway({
      spreadsheetId: "SS1",
      timeZone: "America/New_York",
      activeUserEmail: "reviewer@example.com",
    });
    expect(g.getSpreadsheetId()).toBe("SS1");
    expect(g.getTimeZone()).toBe("America/New_York");
    expect(g.getActiveUserEmail()).toBe("reviewer@example.com");
  });

  it("returns null when the active user email is unavailable", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
    expect(g.getActiveUserEmail()).toBeNull();
  });

  it("round-trips a range write and read", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
    g.loadSheet("Participants", {
      values: [
        ["First Name", "Last Name", "ZIP"],
        ["Zanael", "Bramock", "01234"],
      ],
    });
    g.writeRange("Participants", "B2:C2", [["Corvina", "07999"]]);
    expect(g.readRange("Participants", "A2:C2")).toEqual([
      ["Zanael", "Corvina", "07999"],
    ]);
  });

  it("returns display values as strings, preserving leading zeros", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
    g.loadSheet("Participants", {
      values: [["ZIP"], ["01234"]],
    });
    expect(g.readDisplayRange("Participants", "A2:A2")).toEqual([["01234"]]);
  });

  it("lists sheets and creates hidden system sheets idempotently", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
    g.loadSheet("Participants", { values: [["First Name"]] });
    expect(g.listSheets().map((s) => s.title)).toEqual(["Participants"]);

    const created = g.insertSheet("_Dedup_Config", { hidden: true });
    expect(created.title).toBe("_Dedup_Config");
    expect(g.getSheetByName("_Dedup_Config")?.hidden).toBe(true);

    // Re-inserting an existing sheet returns the existing one (no duplicate).
    const again = g.insertSheet("_Dedup_Config", { hidden: true });
    expect(again.sheetId).toBe(created.sheetId);
    expect(g.listSheets().filter((s) => s.title === "_Dedup_Config")).toHaveLength(1);
  });

  it("appends rows after the last populated row", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
    g.loadSheet("_Dedup_Audit", { values: [["ts", "event"]] });
    g.appendRows("_Dedup_Audit", [["t1", "ID_ASSIGNED"]]);
    g.appendRows("_Dedup_Audit", [["t2", "APPLY_COMPLETED"]]);
    expect(g.readRange("_Dedup_Audit", "A1:B3")).toEqual([
      ["ts", "event"],
      ["t1", "ID_ASSIGNED"],
      ["t2", "APPLY_COMPLETED"],
    ]);
  });

  it("records the last batchUpdate request object", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
    g.loadSheet("Participants", { values: [["A"], ["B"], ["C"]] });
    const sheetId = g.getSheetByName("Participants")!.sheetId;
    const request: SheetsBatchUpdateRequest = {
      requests: [
        { deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: 2 } } },
      ],
    };
    g.batchUpdate(request);
    expect(g.getLastBatchUpdate()).toEqual(request);
  });

  it("applies deleteDimension ROWS to the in-memory grid", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
    g.loadSheet("Participants", { values: [["r1"], ["r2"], ["r3"], ["r4"]] });
    const sheetId = g.getSheetByName("Participants")!.sheetId;
    // Delete rows 2 and 4 (0-based indexes 1 and 3), descending intervals.
    g.batchUpdate({
      requests: [
        { deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: 3, endIndex: 4 } } },
        { deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: 2 } } },
      ],
    });
    expect(g.readRange("Participants", "A1:A2")).toEqual([["r1"], ["r3"]]);
  });

  it("applies updateCells to the in-memory grid", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
    g.loadSheet("Participants", { values: [["", ""]] });
    const sheetId = g.getSheetByName("Participants")!.sheetId;
    g.batchUpdate({
      requests: [
        {
          updateCells: {
            range: { sheetId, startRowIndex: 0, startColumnIndex: 1 },
            fields: "userEnteredValue",
            rows: [{ values: [{ userEnteredValue: { stringValue: "filled" } }] }],
          },
        },
      ],
    });
    expect(g.readRange("Participants", "A1:B1")).toEqual([["", "filled"]]);
  });

  it("applies copyPaste PASTE_VALUES between cells", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
    g.loadSheet("Participants", { values: [["source", ""]] });
    const sheetId = g.getSheetByName("Participants")!.sheetId;
    g.batchUpdate({
      requests: [
        {
          copyPaste: {
            source: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
            destination: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
            pasteType: "PASTE_VALUES",
          },
        },
      ],
    });
    expect(g.readRange("Participants", "A1:B1")).toEqual([["source", "source"]]);
  });

  it("applies appendCells within a batchUpdate", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
    g.loadSheet("_Dedup_Audit", { values: [["ts", "event"]] });
    const sheetId = g.getSheetByName("_Dedup_Audit")!.sheetId;
    g.batchUpdate({
      requests: [
        {
          appendCells: {
            sheetId,
            fields: "userEnteredValue",
            rows: [
              {
                values: [
                  { userEnteredValue: { stringValue: "t9" } },
                  { userEnteredValue: { stringValue: "ROW_DELETED" } },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(g.readRange("_Dedup_Audit", "A2:B2")).toEqual([["t9", "ROW_DELETED"]]);
  });

  it("batchGet returns each requested range in order", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
    g.loadSheet("Participants", { values: [["a", "b"], ["c", "d"]] });
    const got = g.batchGet([
      { sheetName: "Participants", a1: "A1:B1" },
      { sheetName: "Participants", a1: "A2:B2" },
    ]);
    expect(got).toEqual([[["a", "b"]], [["c", "d"]]]);
  });

  it("grants a document lock and throws LOCK_TIMEOUT on double-acquire", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1" });
    const lock = g.getDocumentLock();
    lock.acquire(1000);
    expect(lock.hasLock()).toBe(true);

    const second = g.getDocumentLock();
    let thrown: unknown;
    try {
      second.acquire(1000);
    } catch (e) {
      thrown = e;
    }
    expect(isDedupError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("LOCK_TIMEOUT");

    // Releasing lets the next caller acquire.
    lock.release();
    const third = g.getDocumentLock();
    expect(() => third.acquire(1000)).not.toThrow();
  });
});
