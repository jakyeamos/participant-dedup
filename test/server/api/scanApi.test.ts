import { describe, expect, it } from "vitest";
import { createApiApp } from "../../../services/api/src/app";
import { remoteConfig, runScanOnGateway } from "../../../services/api/src/scanJobs";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { ensureSystemSheets } from "@/server/systemSheets";
import { cloneDefaultConfig } from "@/shared/config";
import { recordsRepository } from "@/server/recordsRepository";
import { clustersRepository } from "@/server/clustersRepository";

const PEOPLE = "Participants";
const HEADER = ["First Name", "Last Name", "DOB", "ZIP", "Address", "City", "State"];
const DUP = ["Ann", "Lee", "1/1/1980", "01234", "10 Oak St", "Boston", "MA"];

describe("services/api scan jobs", () => {
  it("caps remote candidate budgets without mutating the caller config", () => {
    const cfg = cloneDefaultConfig();
    cfg.blocking.maxTotalCandidates = 500_000;

    expect(remoteConfig(cfg).blocking.maxTotalCandidates).toBe(300_000);
    expect(cfg.blocking.maxTotalCandidates).toBe(500_000);
  });

  it("runs the sync engine on an in-memory workbook and produces clusters", () => {
    const cfg = cloneDefaultConfig();
    const g = new FakeSheetsGateway({
      spreadsheetId: "SS-API",
      activeUserEmail: "api@test",
      activeSheetName: PEOPLE,
    });
    ensureSystemSheets(g, cfg);
    g.loadSheet(PEOPLE, {
      values: [HEADER, DUP, [...DUP], ["Bob", "Kim", "2/2/1975", "02345", "1 A St", "Salem", "MA"]],
    });

    const state = runScanOnGateway(g, PEOPLE, cfg);
    expect(state.status).toBe("READY");
    expect(state.metrics.records).toBe(3);
    expect(state.metrics.clusters).toBeGreaterThanOrEqual(1);
    expect(recordsRepository(g).readByBatch(state.batchId, HEADER).length).toBe(3);
    expect(clustersRepository(g).listByBatch(state.batchId).length).toBe(state.metrics.clusters);
  });
});

describe("services/api HTTP auth", () => {
  it("rejects missing API keys and accepts a valid key on health-adjacent routes", async () => {
    const jobs = {
      start: async () => ({
        batchId: "b1",
        state: {
          batchId: "b1",
          status: "READY" as const,
          phase: "READY",
          metrics: { records: 0, candidates: 0, qualifiedEdges: 0, clusters: 0, sourceRows: 0 },
          warnings: [],
        },
        running: false,
        error: null,
        timings: { loadMs: 1, scanMs: 2, flushMs: 3, sheetsLoaded: 2, progressFlushes: 1 },
      }),
      get: async () => {
        throw new Error("unused");
      },
      cancel: async () => {
        throw new Error("unused");
      },
    };
    const app = createApiApp({ apiKey: "secret", jobs: jobs as never });

    const health = await app.request("/health");
    expect(health.status).toBe(200);

    const denied = await app.request("/v1/scans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spreadsheetId: "x", sheetName: "y" }),
    });
    expect(denied.status).toBe(401);

    const ok = await app.request("/v1/scans", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "secret" },
      body: JSON.stringify({ spreadsheetId: "x", sheetName: "y" }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { batchId: string };
    expect(body.batchId).toBe("b1");
  });
});
