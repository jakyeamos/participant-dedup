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
        .map((r) => ({
          batchId: r.batchId as string,
          pairKey: r.pairKey as string,
          leftId: r.leftId as string,
          rightId: r.rightId as string,
          generationReasons: (r.generationReasons as unknown as string[]) ?? [],
          preScore: r.preScore as number,
          scoreStatus: r.scoreStatus as PairScoreStatus,
          score: (r.score as unknown as PairScore | null) ?? null,
          qualified: Boolean(r.qualified),
        }));
    },
  };
}
