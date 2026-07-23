import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import { cloneDefaultConfig, type DedupConfig } from "@/shared/config";
import { SYSTEM_SHEETS } from "@/shared/constants";
import { nowIso, tableFor } from "@/server/systemSheets";

export interface ConfigRepository {
  load(): DedupConfig;
  put(topLevelKey: keyof DedupConfig, value: unknown): void;
}

export function configRepository(gateway: SheetsGateway): ConfigRepository {
  const table = tableFor(gateway, SYSTEM_SHEETS.config);

  return {
    load(): DedupConfig {
      const merged = cloneDefaultConfig() as Record<string, unknown>;
      for (const row of table.rows()) {
        const key = row.configKey as string;
        if (key in merged && row.valueJson != null) {
          merged[key] = row.valueJson;
        }
      }
      return merged as unknown as DedupConfig;
    },

    put(topLevelKey: keyof DedupConfig, value: unknown): void {
      const actor = gateway.getActiveUserEmail() ?? "unknown";
      const ts = nowIso(gateway);
      const existing = table
        .rowsWithIndex()
        .find((r) => r.rec.configKey === topLevelKey);
      const rec = {
        configKey: topLevelKey,
        valueJson: value,
        description: existing ? existing.rec.description : "",
        schemaVersion: existing ? existing.rec.schemaVersion : cloneDefaultConfig().schemaVersion,
        updatedAt: ts,
        updatedBy: actor,
      };
      if (existing) table.writeAt(existing.index, rec);
      else table.append(rec);
    },
  };
}
