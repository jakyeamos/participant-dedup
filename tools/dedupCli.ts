/**
 * Local dedup CLI — Excel (default) or Google Sheets.
 *
 * Simple (after dedup.config.json is set):
 *   ./dedup scan
 *   ./dedup review
 *   ./dedup apply
 *   ./dedup          # interactive menu
 *
 * Full flags still work; see --help.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { cloneDefaultConfig } from "@/shared/config";
import { ensureSystemSheets, tableFor } from "@/server/systemSheets";
import { advanceScan, startScan, stateFromBatch } from "@/server/scan/scanStateMachine";
import { batchesRepository } from "@/server/batchesRepository";
import { clustersRepository } from "@/server/clustersRepository";
import { getQueuePage } from "@/server/review/queue";
import { getClusterDetail } from "@/server/review/clusterDetail";
import { saveClusterDecision } from "@/server/review/decisions";
import { getBatchSummary } from "@/server/review/summary";
import { createApplyChallenge } from "@/server/apply/preflight";
import { applyDecisions } from "@/server/apply/applyDecisions";
import { SYSTEM_SHEETS } from "@/shared/constants";
import type { Confidence } from "@/shared/constants";
import type { ClusterDecision } from "@/server/types";
import type { FakeSheetsGateway } from "@/server/sheets/FakeSheetsGateway";
import type { DedupConfig } from "@/shared/config";
import {
  defaultDedupOutPath,
  loadXlsxFile,
  saveXlsxFile,
} from "@/server/sheets/xlsxWorkbook";
import { GoogleWorkbookBridge } from "../services/api/src/googleWorkbookBridge";

type Args = Record<string, string | boolean>;
type Backend = "xlsx" | "sheets";

interface Session {
  backend: Backend;
  gateway: FakeSheetsGateway;
  /** Participant tab name when known. */
  sheetName: string | null;
  label: string;
  persist: () => Promise<void>;
}

interface FileConfig {
  backend?: string;
  spreadsheet?: string;
  sheet?: string;
  file?: string;
  saJson?: string;
  out?: string;
  confidence?: string;
}

function usage(): never {
  process.stderr.write(`Simple use (put settings in dedup.config.json — see docs/COWORKER.md):

  ./dedup              interactive menu
  ./dedup scan         find duplicates
  ./dedup review       choose what to keep
  ./dedup apply        delete marked rows (asks to confirm)

Shortcuts: s=scan  r=review  a=apply  q=queue

Optional flags still work (--file, --spreadsheet, --sheet, --backend, --sa-json, …).
Single binary: pnpm dedup:compile
`);
  process.exit(2);
}

function resolveCmd(raw: string | undefined): string | null {
  if (!raw) return null;
  const key = raw.toLowerCase();
  const aliases: Record<string, string> = {
    scan: "scan",
    s: "scan",
    queue: "queue",
    q: "queue",
    review: "review",
    r: "review",
    "auto-review": "auto-review",
    apply: "apply",
    a: "apply",
  };
  return aliases[key] ?? null;
}

function parseArgs(argv: string[]): { cmd: string | null; args: Args } {
  const [rawCmd, ...rest] = argv;
  if (rawCmd === "-h" || rawCmd === "--help") usage();
  const cmd = resolveCmd(rawCmd);
  if (rawCmd && !cmd && !rawCmd.startsWith("--")) {
    process.stderr.write(`Unknown command: ${rawCmd}\n\n`);
    usage();
  }
  const start = cmd ? 0 : -1;
  const tokens = cmd ? rest : argv;
  const args: Args = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.startsWith("--")) usage();
    const key = tok.slice(2);
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  void start;
  return { cmd, args };
}

function configCandidates(): string[] {
  const fromEnv = process.env.DEDUP_CONFIG;
  const here = [
    ...(fromEnv ? [resolve(fromEnv)] : []),
    resolve(process.cwd(), "dedup.config.json"),
    resolve(dirname(process.execPath), "dedup.config.json"),
  ];
  const argv1 = process.argv[1];
  if (argv1) here.push(resolve(dirname(argv1), "dedup.config.json"));
  return here;
}

function loadFileConfig(): FileConfig {
  for (const path of configCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as FileConfig;
      return parsed;
    } catch (err) {
      throw new Error(`Invalid config ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {};
}

/** Fill missing CLI flags from dedup.config.json (flags always win). */
function mergeConfig(args: Args): Args {
  const cfg = loadFileConfig();
  const out: Args = { ...args };
  const pairs: Array<[keyof FileConfig, string]> = [
    ["backend", "backend"],
    ["spreadsheet", "spreadsheet"],
    ["sheet", "sheet"],
    ["file", "file"],
    ["saJson", "sa-json"],
    ["out", "out"],
    ["confidence", "confidence"],
  ];
  for (const [ck, ak] of pairs) {
    if (out[ak] !== undefined) continue;
    const value = cfg[ck];
    if (value === undefined || value === null || String(value).trim() === "") continue;
    if (String(value) === "PUT_TAB_NAME_HERE") continue;
    out[ak] = String(value);
  }
  return out;
}

async function pickCommandMenu(): Promise<string> {
  if (!process.stdin.isTTY) usage();
  const choice = await p.select({
    message: "What do you want to do?",
    options: [
      { value: "scan", label: "Scan", hint: "find duplicates" },
      { value: "review", label: "Review", hint: "choose what to keep" },
      { value: "apply", label: "Apply", hint: "delete marked rows" },
      { value: "queue", label: "Queue", hint: "list matches only" },
    ],
  });
  if (p.isCancel(choice)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return String(choice);
}

function backendOf(args: Args): Backend {
  const raw = typeof args.backend === "string" ? args.backend.toLowerCase() : "xlsx";
  if (raw === "xlsx" || raw === "excel") return "xlsx";
  if (raw === "sheets" || raw === "google") return "sheets";
  throw new Error(`Unknown --backend ${String(args.backend)} (use xlsx|sheets)`);
}

function localCfg(): DedupConfig {
  const cfg = cloneDefaultConfig();
  cfg.execution.sliceBudgetMs = 0;
  cfg.execution.inMemoryPairScoreMax = Math.max(cfg.execution.inMemoryPairScoreMax, 200000);
  return cfg;
}

function requireFile(args: Args): string {
  const file = args.file;
  if (typeof file !== "string" || !file) {
    process.stderr.write(
      "Missing file — set \"file\" in dedup.config.json or pass --file path.xlsx\n",
    );
    usage();
  }
  return resolve(file);
}

function requireSpreadsheet(args: Args): string {
  const id = args.spreadsheet;
  if (typeof id !== "string" || !id) {
    process.stderr.write(
      "Missing spreadsheet — set \"spreadsheet\" in dedup.config.json or pass --spreadsheet id\n",
    );
    usage();
  }
  return id;
}

function loadServiceAccountJson(args: Args): string {
  if (typeof args["sa-json"] === "string" && args["sa-json"]) {
    return readFileSync(resolve(args["sa-json"]), "utf8");
  }
  const env = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (env && env.trim()) return env;
  throw new Error(
    "Sheets backend needs GOOGLE_SERVICE_ACCOUNT_JSON or --sa-json ./sa.json",
  );
}

function outPath(args: Args, input: string): string {
  return typeof args.out === "string" && args.out ? resolve(args.out) : defaultDedupOutPath(input);
}

function runToReady(g: FakeSheetsGateway, cfg: DedupConfig): void {
  let state = advanceScan(g, cfg);
  let guard = 0;
  while (state.status !== "READY" && state.status !== "FAILED" && guard++ < 200_000) {
    state = advanceScan(g, cfg);
  }
  if (state.status !== "READY") {
    throw new Error(`scan ended ${state.status}${state.errorCode ? ` (${state.errorCode})` : ""}`);
  }
}

function latestBatchId(g: FakeSheetsGateway): string {
  const active = batchesRepository(g).getActive();
  if (active?.batchId) return String(active.batchId);
  const rows = tableFor(g, SYSTEM_SHEETS.batches).rows();
  if (rows.length === 0) throw new Error("No batches in workbook — run scan first");
  const sorted = [...rows].sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
  return String(sorted[0]!.batchId);
}

function resolveBatch(g: FakeSheetsGateway, args: Args): string {
  return typeof args.batch === "string" && args.batch ? args.batch : latestBatchId(g);
}

function sourceSheetFromBatch(g: FakeSheetsGateway, batchId: string): string | null {
  const batch = batchesRepository(g).get(batchId);
  const name = batch?.sourceSheetName;
  return name ? String(name) : null;
}

async function openSession(
  args: Args,
  opts: { needSource: boolean; persistMode: "scan-out" | "inplace" },
): Promise<Session> {
  const backend = backendOf(args);
  const cfg = localCfg();

  if (backend === "xlsx") {
    const file = requireFile(args);
    const sheetArg = typeof args.sheet === "string" && args.sheet ? args.sheet : null;
    const gateway = await loadXlsxFile(file, { activeSheetName: sheetArg });
    ensureSystemSheets(gateway, cfg);
    let sheetName = sheetArg ?? gateway.getActiveSheetName();
    if (opts.needSource && !sheetName) {
      throw new Error("No sheet to use — pass --sheet Name");
    }
    if (sheetName) gateway.setActiveSheet(sheetName);
    const out =
      typeof args.out === "string" && args.out
        ? resolve(args.out)
        : opts.persistMode === "scan-out"
          ? outPath(args, file)
          : file;
    return {
      backend,
      gateway,
      sheetName,
      label: file,
      persist: async () => {
        await saveXlsxFile(gateway, out);
      },
    };
  }

  const spreadsheetId = requireSpreadsheet(args);
  const bridge = new GoogleWorkbookBridge(loadServiceAccountJson(args));
  let sheetName = typeof args.sheet === "string" && args.sheet ? args.sheet : null;

  let loaded = await bridge.load(spreadsheetId, sheetName, "scan");
  let gateway = loaded.gateway;
  ensureSystemSheets(gateway, cfg);

  if (!sheetName && opts.persistMode === "scan-out") {
    throw new Error("Sheets scan requires --sheet Name");
  }

  if (!sheetName) {
    try {
      const batchId = resolveBatch(gateway, args);
      sheetName = sourceSheetFromBatch(gateway, batchId);
    } catch {
      sheetName = null;
    }
    if (sheetName && !gateway.getSheetByName(sheetName)) {
      loaded = await bridge.load(spreadsheetId, sheetName, "scan");
      gateway = loaded.gateway;
      ensureSystemSheets(gateway, cfg);
    }
  }

  if (opts.needSource && !sheetName) {
    throw new Error("No source sheet — pass --sheet Name or run scan first");
  }

  if (opts.needSource && sheetName && !gateway.getSheetByName(sheetName)) {
    throw new Error(`Sheet not found: ${sheetName}`);
  }
  if (sheetName) gateway.setActiveSheet(sheetName);

  return {
    backend,
    gateway,
    sheetName,
    label: `sheets:${spreadsheetId}`,
    persist: async () => {
      await bridge.flushCliOutputs(spreadsheetId, gateway, sheetName);
    },
  };
}

async function cmdScan(args: Args): Promise<void> {
  const cfg = localCfg();
  const session = await openSession(args, { needSource: true, persistMode: "scan-out" });
  const target = session.sheetName;
  if (!target) throw new Error("No sheet to scan — pass --sheet Name");

  const started = startScan(session.gateway, target, cfg);
  const t0 = Date.now();
  runToReady(session.gateway, cfg);
  const elapsedMs = Date.now() - t0;
  const batch = batchesRepository(session.gateway).get(started.batchId);
  if (!batch) throw new Error(`batch missing after scan: ${started.batchId}`);
  const state = stateFromBatch(batch);

  await session.persist();
  const outputLine =
    session.backend === "xlsx"
      ? `  output:    ${typeof args.out === "string" && args.out ? resolve(args.out) : outPath(args, requireFile(args))}`
      : `  flushed:   ${session.label}`;

  process.stdout.write(
    [
      `scan complete`,
      `  backend:   ${session.backend}`,
      `  input:     ${session.label}`,
      `  sheet:     ${target}`,
      `  batchId:   ${started.batchId}`,
      `  status:    ${state.status}`,
      `  records:   ${state.metrics.records}`,
      `  candidates:${state.metrics.candidates}`,
      `  clusters:  ${state.metrics.clusters}`,
      `  warnings:  ${state.warnings.join(", ") || "-"}`,
      `  scanMs:    ${elapsedMs}`,
      outputLine,
      "",
    ].join("\n"),
  );
}

async function cmdQueue(args: Args): Promise<void> {
  const cfg = localCfg();
  const session = await openSession(args, { needSource: false, persistMode: "inplace" });
  const batchId = resolveBatch(session.gateway, args);
  const queue = getQueuePage(
    session.gateway,
    {
      batchId,
      confidence: ["HIGH", "MEDIUM"],
      statuses: ["UNREVIEWED", "IN_PROGRESS", "READY_TO_APPLY"],
      pageSize: 100,
    },
    cfg,
  );
  const lines = [
    `queue — ${session.label}`,
    `  backend:      ${session.backend}`,
    `  batchId:      ${batchId}`,
    `  total:        ${queue.counts.total}`,
    `  readyToApply: ${queue.counts.readyToApply}`,
    `  byConfidence: ${JSON.stringify(queue.counts.byConfidence)}`,
    `  showing:      ${queue.items.length} of ${queue.filteredCount}`,
  ];
  for (const item of queue.items) {
    lines.push(
      `  - ${item.status} ${item.confidence} ${item.score.toFixed(2)} ${item.label} ` +
        `(${item.memberCount} records, row ${item.firstSourceRow}) [${item.clusterId}]`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdAutoReview(args: Args): Promise<void> {
  const cfg = localCfg();
  const session = await openSession(args, { needSource: false, persistMode: "inplace" });
  const band = (
    typeof args.confidence === "string" && args.confidence ? args.confidence : "HIGH"
  ).toUpperCase() as Confidence;
  const batchId = resolveBatch(session.gateway, args);

  const queue = getQueuePage(
    session.gateway,
    {
      batchId,
      confidence: [band],
      statuses: ["UNREVIEWED", "IN_PROGRESS"],
      pageSize: 500,
    },
    cfg,
  );

  let saved = 0;
  for (const item of queue.items) {
    const detail = getClusterDetail(session.gateway, batchId, item.clusterId, cfg);
    if (detail.records.length < 2) continue;
    const retained = detail.records[0]!.dedupId;
    const deleted = detail.records.slice(1).map((r) => r.dedupId);
    const decision: ClusterDecision = {
      batchId,
      clusterId: item.clusterId,
      expectedRevision: detail.revision,
      mode: "SELECT_RECORDS",
      retainedIds: [retained],
      deleteAssignments: Object.fromEntries(deleted.map((id) => [id, retained])),
      fieldChoices: {},
      notes: `dedup-cli auto-review keep-first (${band})`,
    };
    saveClusterDecision(session.gateway, decision, cfg);
    saved += 1;
  }

  await session.persist();
  process.stdout.write(
    `auto-review: saved ${saved} ${band} cluster(s) → ${session.label}\n`,
  );
}

async function runApply(
  session: Session,
  batchId: string,
  cfg: DedupConfig,
): Promise<{ deletedRows: number; filledFields: number; auditWritten: number; decisions: number }> {
  const decisions = clustersRepository(session.gateway)
    .listByBatch(batchId)
    .filter((row) => String(row.status) === "READY_TO_APPLY")
    .map((row) => row.decision as unknown as ClusterDecision)
    .filter(Boolean);

  if (decisions.length === 0) {
    return { deletedRows: 0, filledFields: 0, auditWritten: 0, decisions: 0 };
  }

  const challenge = createApplyChallenge(session.gateway, batchId, decisions, cfg);
  const result = applyDecisions(
    session.gateway,
    batchId,
    decisions,
    { token: challenge.token, summaryHash: challenge.summaryHash, confirmed: true },
    cfg,
  );
  await session.persist();
  return {
    deletedRows: result.deletedRows,
    filledFields: result.filledFields,
    auditWritten: result.auditWritten,
    decisions: decisions.length,
  };
}

function formatRecordCard(
  detail: ReturnType<typeof getClusterDetail>,
  index: number,
): string {
  const rec = detail.records[index]!;
  const bits = detail.headers
    .map((h, i) => `${h}=${rec.values[i] ?? ""}`)
    .filter((line) => !line.endsWith("="))
    .slice(0, 6);
  return `${index + 1}. ${rec.label} (row ${rec.sourceRow})  ${bits.join(" · ")}`;
}

async function cmdReview(args: Args): Promise<void> {
  const cfg = localCfg();
  const session = await openSession(args, { needSource: false, persistMode: "inplace" });
  const batchId = resolveBatch(session.gateway, args);

  p.intro(pc.cyan(`dedup review — ${session.label}`));

  let saved = 0;
  for (;;) {
    const queue = getQueuePage(
      session.gateway,
      {
        batchId,
        confidence: ["HIGH", "MEDIUM"],
        statuses: ["UNREVIEWED", "IN_PROGRESS"],
        pageSize: 50,
      },
      cfg,
    );

    if (queue.items.length === 0) {
      p.note("No unreviewed HIGH/MEDIUM clusters left.", "Queue empty");
      break;
    }

    p.log.message(
      `${queue.items.length} waiting · readyToApply=${queue.counts.readyToApply} · saved this session=${saved}`,
    );

    const choice = await p.select({
      message: "Pick a cluster",
      options: [
        ...queue.items.map((item) => ({
          value: item.clusterId,
          label: `${item.confidence} ${item.score.toFixed(0)}  ${item.label}`,
          hint: `${item.memberCount} records · row ${item.firstSourceRow}`,
        })),
        { value: "__done__", label: "Done reviewing", hint: "save & maybe apply" },
      ],
    });

    if (p.isCancel(choice) || choice === "__done__") break;

    const detail = getClusterDetail(session.gateway, batchId, String(choice), cfg);
    const body = [
      `${detail.confidence} score=${detail.score.toFixed(2)} revision=${detail.revision}`,
      ...detail.records.map((_, i) => formatRecordCard(detail, i)),
      detail.differingHeaders.length
        ? `differing: ${detail.differingHeaders.join(", ")}`
        : "fields agree across members",
    ].join("\n");
    p.note(body, detail.records[0]?.label ?? detail.clusterId.slice(0, 8));

    const action = await p.select({
      message: "Decision",
      options: [
        { value: "keep-first", label: "Keep first record, delete the rest" },
        { value: "keep-pick", label: "Pick which record to keep" },
        { value: "skip", label: "Skip (leave unreviewed)" },
        { value: "quit", label: "Quit review" },
      ],
    });

    if (p.isCancel(action) || action === "quit") break;
    if (action === "skip") continue;

    let keepIndex = 0;
    if (action === "keep-pick") {
      const picked = await p.select({
        message: "Keep which record?",
        options: detail.records.map((rec, i) => ({
          value: String(i),
          label: `${i + 1}. ${rec.label}`,
          hint: `row ${rec.sourceRow}`,
        })),
      });
      if (p.isCancel(picked)) break;
      keepIndex = Number(picked);
    }

    if (detail.records.length < 2) {
      p.log.warn("Cluster has fewer than 2 records — skipped");
      continue;
    }

    const retained = detail.records[keepIndex]!.dedupId;
    const deleted = detail.records.filter((_, i) => i !== keepIndex).map((r) => r.dedupId);
    const decision: ClusterDecision = {
      batchId,
      clusterId: detail.clusterId,
      expectedRevision: detail.revision,
      mode: "SELECT_RECORDS",
      retainedIds: [retained],
      deleteAssignments: Object.fromEntries(deleted.map((id) => [id, retained])),
      fieldChoices: {},
      notes: "dedup-cli review TUI",
    };
    saveClusterDecision(session.gateway, decision, cfg);
    saved += 1;
    p.log.success(`Saved — keep ${retained}, delete ${deleted.length}`);
  }

  await session.persist();

  const summary = getBatchSummary(session.gateway, batchId, cfg);
  if (summary.rowsToDelete > 0 && process.stdin.isTTY) {
    const doApply = await p.confirm({
      message: `Apply now? (${summary.rowsToDelete} rows to delete)`,
      initialValue: false,
    });
    if (!p.isCancel(doApply) && doApply) {
      if (!session.sheetName) {
        session.sheetName = sourceSheetFromBatch(session.gateway, batchId);
      }
      const result = await runApply(session, batchId, cfg);
      p.outro(
        `Applied ${result.decisions} decision(s): deleted=${result.deletedRows} audit=${result.auditWritten}`,
      );
      return;
    }
  } else if (summary.rowsToDelete > 0) {
    p.outro(
      `Review saved (${saved} decision(s)). ${summary.rowsToDelete} rows ready — run: dedup apply`,
    );
    return;
  }

  p.outro(`Review saved (${saved} decision(s)) → ${session.label}`);
}

async function cmdApply(args: Args): Promise<void> {
  if (args.confirm !== true) {
    if (process.stdin.isTTY) {
      const ok = await p.confirm({
        message: "Apply will delete marked duplicate rows. Continue?",
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Apply cancelled");
        process.exit(0);
      }
    } else {
      process.stderr.write("Refusing apply without --confirm (non-interactive)\n");
      process.exit(1);
    }
  }
  const cfg = localCfg();
  const session = await openSession(args, { needSource: true, persistMode: "inplace" });
  const batchId = resolveBatch(session.gateway, args);
  if (!session.sheetName) {
    session.sheetName = sourceSheetFromBatch(session.gateway, batchId);
  }

  const summary = getBatchSummary(session.gateway, batchId, cfg);
  const result = await runApply(session, batchId, cfg);
  if (result.decisions === 0) {
    process.stdout.write("apply: nothing READY_TO_APPLY\n");
    return;
  }
  process.stdout.write(
    [
      `apply complete`,
      `  backend:   ${session.backend}`,
      `  target:    ${session.label}`,
      `  batchId:   ${batchId}`,
      `  decisions: ${result.decisions}`,
      `  rowsToDelete (pre): ${summary.rowsToDelete}`,
      `  deleted:   ${result.deletedRows}`,
      `  filled:    ${result.filledFields}`,
      `  audit:     ${result.auditWritten}`,
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  let { cmd, args } = parseArgs(process.argv.slice(2));
  args = mergeConfig(args);
  if (!cmd) cmd = await pickCommandMenu();

  switch (cmd) {
    case "scan":
      await cmdScan(args);
      break;
    case "queue":
      await cmdQueue(args);
      break;
    case "review":
      await cmdReview(args);
      break;
    case "auto-review":
      await cmdAutoReview(args);
      break;
    case "apply":
      await cmdApply(args);
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n`);
      usage();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
