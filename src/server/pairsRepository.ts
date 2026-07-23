import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { PairScore } from "@/server/types";
import { SYSTEM_SHEETS } from "@/shared/constants";
import { tableFor } from "@/server/systemSheets";

export type PairScoreStatus = "PENDING" | "SCORED" | "ERROR";

export interface PairRecord {
  batchId: string;
  pairKey: string;
  leftId: string;
  rightId: string;
  generationReasons: string[];
  preScore: number;
  scoreStatus: PairScoreStatus;
  score: PairScore | null;
  qualified: boolean;
}

export interface PairsRepository {
  append(pairs: PairRecord[]): void;
  readByBatch(batchId: string): PairRecord[];
  /** Pending pairs for a batch with their grid row index, capped at `limit`. */
  readPendingWithIndex(batchId: string, limit: number): Array<{ index: number; rec: PairRecord }>;
  /** Overwrite the pair at a grid row index (used to persist a scored result). */
  writeAt(index: number, rec: PairRecord): void;
  /** Blank every pair row for a batch (working rows are transient after clustering). */
  deleteByBatch(batchId: string): void;
}

function toPairRecord(r: Record<string, unknown>): PairRecord {
  return {
    batchId: r.batchId as string,
    pairKey: r.pairKey as string,
    leftId: r.leftId as string,
    rightId: r.rightId as string,
    generationReasons: (r.generationReasons as unknown as string[]) ?? [],
    preScore: r.preScore as number,
    scoreStatus: r.scoreStatus as PairScoreStatus,
    score: (r.score as unknown as PairScore | null) ?? null,
    qualified: Boolean(r.qualified),
  };
}

export function pairsRepository(gateway: SheetsGateway): PairsRepository {
  const table = tableFor(gateway, SYSTEM_SHEETS.pairs);

  return {
    append(pairs: PairRecord[]): void {
      table.appendMany(pairs as unknown as Record<string, unknown>[]);
    },

    readByBatch(batchId: string): PairRecord[] {
      return table
        .rows()
        .filter((r) => r.batchId === batchId)
        .map(toPairRecord);
    },

    readPendingWithIndex(batchId, limit): Array<{ index: number; rec: PairRecord }> {
      const out: Array<{ index: number; rec: PairRecord }> = [];
      for (const { index, rec } of table.rowsWithIndex()) {
        if (rec.batchId !== batchId) continue;
        if (rec.scoreStatus !== "PENDING") continue;
        out.push({ index, rec: toPairRecord(rec) });
        if (out.length >= limit) break;
      }
      return out;
    },

    writeAt(index, rec): void {
      table.writeAt(index, rec as unknown as Record<string, unknown>);
    },

    deleteByBatch(batchId): void {
      for (const { index, rec } of table.rowsWithIndex()) {
        if (rec.batchId === batchId) table.writeAt(index, {});
      }
    },
  };
}
