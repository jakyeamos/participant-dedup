import { describe, expect, it } from "vitest";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { resolveSchema } from "@/server/schemaResolver";
import { ensureSystemSheets } from "@/server/systemSheets";
import { auditRepository } from "@/server/auditRepository";
import { batchesRepository } from "@/server/batchesRepository";
import { stateRepository } from "@/server/stateRepository";
import {
  detectDuplicateIds,
  ensureDedupIds,
  repairDuplicateIds,
} from "@/server/dedupIdService";
import { auditActor, resolveReviewer } from "@/server/identity";
import { cloneDefaultConfig } from "@/shared/config";
import { isDedupError } from "@/server/errors";

const cfg = cloneDefaultConfig();

describe("ensureDedupIds", () => {
  it("inserts a hidden _Dedup_ID column and assigns a UUID per participant row", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: "r@x.com" });
    ensureSystemSheets(g, cfg);
    g.loadSheet("P", {
      values: [
        ["First Name", "Last Name", "DOB", "ZIP"],
        ["Ann", "Lee", "1/1/1980", "01234"],
        ["Bob", "Kim", "2/2/1980", "02345"],
        ["", "", "", ""],
      ],
    });
    const schema = resolveSchema(g, "P", cfg);
    const res = ensureDedupIds(g, schema, cfg, auditActor(g));

    expect(res.assigned).toBe(2);
    expect(g.readRange("P", "E1:E1")[0]![0]).toBe("_Dedup_ID");
    const ids = g.readRange("P", "E2:E4").map((r) => r[0]);
    expect(ids[0]).not.toBe("");
    expect(ids[1]).not.toBe("");
    expect(ids[2]).toBe("");
    expect(new Set(ids.filter(Boolean)).size).toBe(2);
    expect(g.isColumnHidden("P", 4)).toBe(true);

    const events = auditRepository(g).readAll().filter((e) => e.eventType === "ID_ASSIGNED");
    expect(events).toHaveLength(2);
    expect(events[0]!.beforeValue).toBeNull();
    expect(events[0]!.afterValue).toBeNull();
    expect(events[0]!.targetDedupId).not.toBe("");
  });

  it("fills only blank IDs in an existing ID column", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: "r@x.com" });
    ensureSystemSheets(g, cfg);
    g.loadSheet("P", {
      values: [
        ["_Dedup_ID", "First Name", "Last Name", "DOB"],
        ["id-A", "Ann", "Lee", "1/1/1980"],
        ["", "Bob", "Kim", "2/2/1980"],
      ],
    });
    const schema = resolveSchema(g, "P", cfg);
    const res = ensureDedupIds(g, schema, cfg, auditActor(g));

    expect(res.assigned).toBe(1);
    const ids = g.readRange("P", "A2:A3").map((r) => r[0]);
    expect(ids[0]).toBe("id-A");
    expect(ids[1]).not.toBe("");
  });
});

describe("detectDuplicateIds", () => {
  it("returns ids that appear more than once, ignoring blanks", () => {
    const dups = detectDuplicateIds([
      { dedupId: "x" },
      { dedupId: "y" },
      { dedupId: "x" },
      { dedupId: "" },
      { dedupId: "" },
    ]);
    expect(dups).toEqual(["x"]);
  });
});

describe("repairDuplicateIds", () => {
  it("keeps the first occurrence, reassigns the rest, and never alters values", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: "r@x.com" });
    ensureSystemSheets(g, cfg);
    g.loadSheet("P", {
      values: [
        ["_Dedup_ID", "First Name", "Last Name", "DOB"],
        ["dup", "Ann", "Lee", "1/1/1980"],
        ["dup", "Bob", "Kim", "2/2/1980"],
        ["keep", "Cara", "Ng", "3/3/1980"],
      ],
    });
    const schema = resolveSchema(g, "P", cfg);
    batchesRepository(g).insert({
      batchId: "B1",
      sourceSpreadsheetId: "SS1",
      sourceSheetId: schema.sheetId,
      sourceSheetName: "P",
      headerRow: 1,
      status: "READY",
      revision: 1,
    });
    stateRepository(g).put("SUPPRESSION", "s1", { memberIds: ["dup", "keep"] });

    const res = repairDuplicateIds(g, schema, auditActor(g));

    expect(res.repaired).toBe(1);
    const ids = g.readRange("P", "A2:A4").map((r) => r[0]);
    expect(ids[0]).toBe("dup");
    expect(ids[1]).not.toBe("dup");
    expect(ids[1]).not.toBe("");
    expect(ids[2]).toBe("keep");
    // Participant values untouched.
    expect(g.readRange("P", "B2:C4")).toEqual([
      ["Ann", "Lee"],
      ["Bob", "Kim"],
      ["Cara", "Ng"],
    ]);
    // Active batch cancelled/stale.
    expect(batchesRepository(g).getActive()).toBeNull();
    // Suppression referencing the duplicated id invalidated.
    const supp = stateRepository(g).get("SUPPRESSION", "s1");
    expect((supp?.valueJson as { invalidated?: boolean }).invalidated).toBe(true);
    // Audit trail.
    const ev = auditRepository(g).readAll().filter((e) => e.eventType === "ID_REPAIRED");
    expect(ev).toHaveLength(1);
  });
});

describe("resolveReviewer", () => {
  it("uses the account email when available", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: "r@x.com" });
    expect(resolveReviewer(g)).toEqual({ email: "r@x.com", display: "r@x.com" });
  });

  it("falls back to a sanitized name when email is unavailable", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: null });
    expect(resolveReviewer(g, "  Jane\t<b>Doe ")).toEqual({
      email: null,
      display: "Jane bDoe",
    });
  });

  it("throws MISSING_REVIEWER_IDENTITY when email is blank and no fallback given", () => {
    const g = new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: null });
    let thrown: unknown;
    try {
      resolveReviewer(g);
    } catch (e) {
      thrown = e;
    }
    expect(isDedupError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("MISSING_REVIEWER_IDENTITY");
  });
});
