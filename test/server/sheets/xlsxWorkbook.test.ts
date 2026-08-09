import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { ensureSystemSheets } from "@/server/systemSheets";
import { cloneDefaultConfig } from "@/shared/config";
import { advanceScan, startScan } from "@/server/scan/scanStateMachine";
import {
  defaultDedupOutPath,
  loadXlsxFile,
  saveXlsxFile,
} from "@/server/sheets/xlsxWorkbook";

async function writeFixtureXlsx(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Participants");
  ws.addRow(["First Name", "Last Name", "DOB", "Address", "City", "State", "ZIP"]);
  ws.addRow(["Ada", "Lovelace", "1815-12-10", "1 Analytical Engine", "London", "EN", "10001"]);
  ws.addRow(["Ada", "Lovelace", "1815-12-10", "1 Analytical Engine", "London", "EN", "10001"]);
  ws.addRow(["Grace", "Hopper", "1906-12-09", "2 Cobol Way", "Arlington", "VA", "22201"]);
  await wb.xlsx.writeFile(path);
}

describe("xlsx workbook IO", () => {
  it("defaultDedupOutPath appends .dedup before extension", () => {
    expect(defaultDedupOutPath("/tmp/a.xlsx")).toBe("/tmp/a.dedup.xlsx");
    expect(defaultDedupOutPath("/tmp/a.XLSX")).toBe("/tmp/a.dedup.xlsx");
  });

  it("round-trips a scan through load → engine → save → reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dedup-xlsx-"));
    const input = join(dir, "participants.xlsx");
    const output = join(dir, "participants.dedup.xlsx");
    try {
      await writeFixtureXlsx(input);
      const cfg = cloneDefaultConfig();
      cfg.execution.sliceBudgetMs = 0;

      const g = await loadXlsxFile(input, { activeSheetName: "Participants" });
      expect(g.getSheetByName("Participants")).not.toBeNull();
      expect(g.getGridSize("Participants").rowCount).toBe(4);

      ensureSystemSheets(g, cfg);
      startScan(g, "Participants", cfg);
      let state = advanceScan(g, cfg);
      let guard = 0;
      while (state.status !== "READY" && state.status !== "FAILED" && guard++ < 10_000) {
        state = advanceScan(g, cfg);
      }
      expect(state.status).toBe("READY");
      expect(state.metrics.clusters).toBeGreaterThan(0);

      await saveXlsxFile(g, output);
      const reloaded = await loadXlsxFile(output);
      expect(reloaded.getSheetByName("_Dedup_Batches")).not.toBeNull();
      expect(reloaded.getSheetByName("_Dedup_Clusters")).not.toBeNull();
      expect(reloaded.getSheetByName("Participants")).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saveXlsxFile writes FakeSheetsGateway dumpSheets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dedup-xlsx-dump-"));
    const path = join(dir, "out.xlsx");
    try {
      const g = new FakeSheetsGateway({ spreadsheetId: "t" });
      g.loadSheet("A", { values: [["h"], ["1"]] });
      await saveXlsxFile(g, path);
      const again = await loadXlsxFile(path);
      expect(again.readRange("A", "A1:A2")).toEqual([["h"], ["1"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a sparse trailing _Dedup_ID header beyond actualColumnCount", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dedup-xlsx-sparse-"));
    const path = join(dir, "sparse.xlsx");
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Participants");
      ws.getCell(1, 1).value = "First";
      ws.getCell(1, 2).value = "Last";
      ws.getCell(1, 3).value = "DOB";
      ws.getCell(1, 27).value = "_Dedup_ID";
      ws.getCell(2, 1).value = "Ada";
      ws.getCell(2, 2).value = "Lovelace";
      ws.getCell(2, 3).value = "1815-12-10";
      await wb.xlsx.writeFile(path);

      const g = await loadXlsxFile(path, { activeSheetName: "Participants" });
      const header = g.readRange("Participants", "A1:AA1")[0] ?? [];
      expect(header[26]).toBe("_Dedup_ID");
      expect(g.getGridSize("Participants").columnCount).toBeGreaterThanOrEqual(27);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
