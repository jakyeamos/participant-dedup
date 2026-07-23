import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { CellValue } from "@/server/types";
import { SYSTEM_SHEETS } from "@/shared/constants";
import { tableFor } from "@/server/systemSheets";

export type ClusterRecord = Record<string, CellValue>;

export interface ClustersRepository {
  append(clusters: Record<string, unknown>[]): void;
  get(clusterId: string): ClusterRecord | null;
  update(clusterId: string, patch: Record<string, unknown>): void;
  listByBatch(batchId: string): ClusterRecord[];
}

export function clustersRepository(gateway: SheetsGateway): ClustersRepository {
  const table = tableFor(gateway, SYSTEM_SHEETS.clusters);

  return {
    append(clusters: Record<string, unknown>[]): void {
      table.appendMany(clusters);
    },

    get(clusterId: string): ClusterRecord | null {
      const found = table.rows().find((r) => r.clusterId === clusterId);
      return found ?? null;
    },

    update(clusterId: string, patch: Record<string, unknown>): void {
      const target = table
        .rowsWithIndex()
        .find((r) => r.rec.clusterId === clusterId);
      if (!target) return;
      table.writeAt(target.index, { ...target.rec, ...patch });
    },

    listByBatch(batchId: string): ClusterRecord[] {
      return table.rows().filter((r) => r.batchId === batchId);
    },
  };
}
