import { describe, expect, it } from "vitest";
import { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import { ensureSystemSheets } from "@/server/systemSheets";
import { configRepository } from "@/server/configRepository";
import { batchesRepository } from "@/server/batchesRepository";
import { recordsRepository } from "@/server/recordsRepository";
import { pairsRepository } from "@/server/pairsRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { stateRepository } from "@/server/stateRepository";
import { auditRepository } from "@/server/auditRepository";
import { cloneDefaultConfig } from "@/shared/config";
import { SYSTEM_SHEETS } from "@/shared/constants";
import type { RecordSnapshot } from "@/server/types";

const cfg = cloneDefaultConfig();

function freshGateway(): FakeSheetsGateway {
  return new FakeSheetsGateway({ spreadsheetId: "SS1", activeUserEmail: "r@example.com" });
}

function sampleRecord(batchId: string): RecordSnapshot {
  return {
    batchId,
    dedupId: "id-1",
    sourceRowAtScan: 4,
    rowFingerprint: "fp1",
    relevantHash: "rh1",
    rawValues: ["id-1", "Zanael", "Bramock"],
    displayValues: ["id-1", "Zanael", "Bramock"],
    formulas: ["", "", ""],
    valuesByHeader: { _Dedup_ID: "id-1", "First Name": "Zanael", "Last Name": "Bramock" },
    displayByHeader: { _Dedup_ID: "id-1", "First Name": "Zanael", "Last Name": "Bramock" },
    normalized: {
      name: {
        firstTokens: ["zanael"],
        middleTokens: [],
        lastTokens: ["bramock"],
        aliasTokens: [],
        coreTokens: ["zanael", "bramock"],
        orderedNoMiddle: "zanael bramock",
        reversedNoMiddle: "bramock zanael",
        sortedTokenSignature: "bramock zanael",
        initials: ["z", "b"],
        missingCoreComponent: false,
      },
      dob: { value: null, state: "MISSING" },
      zip: null,
      address: null,
      city: null,
      state: null,
      county: null,
      extras: {},
    },
  };
}

describe("ensureSystemSheets", () => {
  it("creates all seven hidden system sheets with header rows", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    for (const name of Object.values(SYSTEM_SHEETS)) {
      const info = g.getSheetByName(name);
      expect(info, name).not.toBeNull();
      expect(info!.hidden, name).toBe(true);
      expect(g.readRange(name, "A1:A1")[0]![0]).not.toBe("");
    }
  });

  it("is idempotent and does not duplicate sheets", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    ensureSystemSheets(g, cfg);
    const titles = g.listSheets().map((s) => s.title);
    for (const name of Object.values(SYSTEM_SHEETS)) {
      expect(titles.filter((t) => t === name)).toHaveLength(1);
    }
  });

  it("records exactly one schema_version SYSTEM state row across re-runs", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    ensureSystemSheets(g, cfg);
    const rows = stateRepository(g)
      .listByType("SYSTEM")
      .filter((r) => r.stateKey === "schema_version");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valueJson).toBe(cfg.schemaVersion);
  });
});

describe("configRepository", () => {
  it("load() merges seeded config over defaults", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    const loaded = configRepository(g).load();
    expect(loaded.thresholds.high).toBe(cfg.thresholds.high);
    expect(loaded.weights.name).toBe(cfg.weights.name);
    expect(loaded.headerSearchRows).toBe(25);
    expect(loaded.execution.maxAtomicApplyRequests).toBe(900);
  });

  it("a stored override wins over the default while unstored keys fall back", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    const repo = configRepository(g);
    repo.put("thresholds", { ...cfg.thresholds, high: 91 });
    const loaded = repo.load();
    expect(loaded.thresholds.high).toBe(91);
    expect(loaded.weights.name).toBe(cfg.weights.name);
  });
});

describe("batchesRepository", () => {
  it("inserts, gets, updates, and tracks the active nonterminal batch", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    const repo = batchesRepository(g);
    repo.insert({
      batchId: "B1",
      sourceSpreadsheetId: "SS1",
      sourceSheetId: 7,
      sourceSheetName: "Participants",
      headerRow: 3,
      status: "SNAPSHOTTING",
      revision: 1,
    });
    expect(repo.get("B1")?.status).toBe("SNAPSHOTTING");
    expect(repo.get("B1")?.sourceSheetId).toBe(7);
    expect(repo.getActive()?.batchId).toBe("B1");

    repo.update("B1", { status: "APPLIED", revision: 2 });
    expect(repo.get("B1")?.status).toBe("APPLIED");
    expect(repo.get("B1")?.revision).toBe(2);
    expect(repo.getActive()).toBeNull();
  });
});

describe("recordsRepository", () => {
  it("round-trips a RecordSnapshot for a batch", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    const headers = ["_Dedup_ID", "First Name", "Last Name"];
    const snap = sampleRecord("B1");
    recordsRepository(g).append([snap]);
    const back = recordsRepository(g).readByBatch("B1", headers);
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(snap);
  });

  it("only returns records for the requested batch", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    const headers = ["_Dedup_ID", "First Name", "Last Name"];
    recordsRepository(g).append([sampleRecord("B1"), sampleRecord("B2")]);
    expect(recordsRepository(g).readByBatch("B1", headers)).toHaveLength(1);
  });
});

describe("pairsRepository", () => {
  it("appends and reads pair rows by batch", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    const repo = pairsRepository(g);
    repo.append([
      {
        batchId: "B1",
        pairKey: "pk1",
        leftId: "id-1",
        rightId: "id-2",
        generationReasons: ["SAME_ZIP"],
        preScore: 12,
        scoreStatus: "PENDING",
        score: null,
        qualified: false,
      },
    ]);
    const back = repo.readByBatch("B1");
    expect(back).toHaveLength(1);
    expect(back[0]!.generationReasons).toEqual(["SAME_ZIP"]);
    expect(back[0]!.qualified).toBe(false);
  });
});

describe("clustersRepository", () => {
  it("appends, gets, and updates a cluster row", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    const repo = clustersRepository(g);
    repo.append([
      {
        batchId: "B1",
        clusterId: "c1",
        clusterType: "CORE",
        memberIds: ["id-1", "id-2"],
        coreMemberIds: ["id-1", "id-2"],
        suggestedMemberIds: [],
        edgeKeys: ["pk1"],
        highestConfidence: "HIGH",
        maxScore: 92,
        warnings: [],
        status: "UNREVIEWED",
        revision: 1,
      },
    ]);
    expect(repo.get("c1")?.status).toBe("UNREVIEWED");
    repo.update("c1", { status: "READY_TO_APPLY", revision: 2 });
    expect(repo.get("c1")?.status).toBe("READY_TO_APPLY");
    expect(repo.listByBatch("B1")).toHaveLength(1);
  });
});

describe("stateRepository", () => {
  it("upserts and reads state rows keyed by type+key", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    const repo = stateRepository(g);
    repo.put("SUPPRESSION", "k1", { memberIds: ["id-1", "id-2"] });
    repo.put("SUPPRESSION", "k1", { memberIds: ["id-3"] });
    const got = repo.get("SUPPRESSION", "k1");
    expect(got?.valueJson).toEqual({ memberIds: ["id-3"] });
    expect(repo.listByType("SUPPRESSION")).toHaveLength(1);
  });
});

describe("auditRepository", () => {
  it("appends an event and blanks value columns for ID_ASSIGNED", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    auditRepository(g).append({
      eventType: "ID_ASSIGNED",
      batchId: "B1",
      targetDedupId: "id-1",
      beforeValue: "should-not-persist",
      afterValue: "should-not-persist",
      result: "SUCCESS",
    });
    const events = auditRepository(g).readAll();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("ID_ASSIGNED");
    expect(events[0]!.beforeValue).toBeNull();
    expect(events[0]!.afterValue).toBeNull();
    expect(events[0]!.eventId).toMatch(/./);
  });

  it("preserves before/after values for FIELD_FILLED", () => {
    const g = freshGateway();
    ensureSystemSheets(g, cfg);
    auditRepository(g).append({
      eventType: "FIELD_FILLED",
      batchId: "B1",
      targetDedupId: "id-1",
      fieldName: "City",
      beforeValue: "",
      afterValue: "Springfield",
      result: "SUCCESS",
    });
    const events = auditRepository(g).readAll();
    expect(events[0]!.afterValue).toBe("Springfield");
  });
});
