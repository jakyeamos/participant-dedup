import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve("tools/dedupCli.ts");

function run(args: string[], env: NodeJS.ProcessEnv = {}): {
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const result = spawnSync("node", ["--import", "tsx", cli, ...args], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

describe("dedup CLI sheets backend guards", () => {
  it("rejects sheets without spreadsheet id", () => {
    const result = run(["scan", "--backend", "sheets", "--sheet", "Participants"], {
      GOOGLE_SERVICE_ACCOUNT_JSON: "",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Missing spreadsheet/i);
  });

  it("rejects sheets without service account credentials", () => {
    const result = run(
      ["scan", "--backend", "sheets", "--spreadsheet", "abc", "--sheet", "Participants"],
      { GOOGLE_SERVICE_ACCOUNT_JSON: "" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/GOOGLE_SERVICE_ACCOUNT_JSON|--sa-json/);
  });

  it("still runs xlsx help path for unknown backend", () => {
    const result = run(["scan", "--backend", "nope", "--file", "x.xlsx"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Unknown --backend/);
  });
});
