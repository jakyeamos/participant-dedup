import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve("tools/dedupCli.ts");

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): {
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const result = spawnSync("node", ["--import", "tsx", cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

describe("dedup CLI config shortcuts", () => {
  it("reads spreadsheet from dedup.config.json so --spreadsheet is optional", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedup-cfg-"));
    const cfgPath = join(dir, "dedup.config.json");
    try {
      writeFileSync(
        cfgPath,
        JSON.stringify({
          backend: "sheets",
          spreadsheet: "cfg-sheet-id",
          sheet: "Participants",
          saJson: join(dir, "missing-sa.json"),
        }),
      );
      const result = run(["scan"], resolve("."), {
        GOOGLE_SERVICE_ACCOUNT_JSON: "",
        DEDUP_CONFIG: cfgPath,
      });
      expect(result.status).not.toBe(0);
      // Got past spreadsheet requirement; failed on SA file / credentials.
      expect(result.stderr + result.stdout).not.toMatch(/Missing spreadsheet/i);
      expect(result.stderr + result.stdout).toMatch(/sa\.json|SERVICE_ACCOUNT|ENOENT|no such file/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts shortcut alias s for scan", () => {
    const result = run(["s", "--backend", "sheets"], resolve("."), {
      GOOGLE_SERVICE_ACCOUNT_JSON: "",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Missing spreadsheet|dedup\.config/i);
  });
});
