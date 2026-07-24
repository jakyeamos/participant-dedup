import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AT-28 proxy + §31: the source tree must not call out to the network or load
 * remote assets. Matching runs entirely on sheet values the user already has.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Drop comments so §-citations and explanatory URLs do not trip the gate. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sourceFiles(): Array<{ path: string; body: string }> {
  return walk(SRC)
    .filter((path) => /\.(ts|tsx|js|mjs|css|html|json)$/.test(path))
    // The Apps Script manifest must list Google OAuth scopes; those https URLs
    // are authorization declarations, not runtime fetches.
    .filter((path) => !path.endsWith(`${join("src", "appsscript.json")}`) && !path.endsWith("/appsscript.json"))
    .map((path) => ({
      path: relative(ROOT, path),
      body: /\.(ts|tsx|js|mjs)$/.test(path)
        ? stripComments(readFileSync(path, "utf8"))
        : readFileSync(path, "utf8"),
    }));
}

describe("static: no external calls (AT-28)", () => {
  const files = sourceFiles();

  it("never references bare fetch( outside the owned-backend relay", () => {
    const hits: string[] = [];
    for (const file of files) {
      // Apps Script uses UrlFetchApp.fetch — allow that only in the relay module.
      if (file.path.replace(/\\/g, "/") === "src/server/scan/remoteScan.ts") continue;
      if (/\bfetch\s*\(/.test(file.body)) hits.push(`${file.path}: fetch(`);
    }
    expect(hits).toEqual([]);
  });

  it("only uses UrlFetchApp in the owned Railway scan relay", () => {
    const hits: string[] = [];
    for (const file of files) {
      if (!/\bUrlFetchApp\b/.test(file.body)) continue;
      if (file.path.replace(/\\/g, "/") === "src/server/scan/remoteScan.ts") continue;
      hits.push(`${file.path}: UrlFetchApp`);
    }
    expect(hits).toEqual([]);
  });

  it("never embeds http(s) URLs outside the Apps Script manifest", () => {
    const hits: string[] = [];
    for (const file of files) {
      const match = file.body.match(/https?:\/\/[^\s"'`]+/gi);
      if (match) hits.push(`${file.path}: ${match.join(", ")}`);
    }
    expect(hits).toEqual([]);
  });

  it("never assigns innerHTML / insertAdjacentHTML / document.write in the client", () => {
    const hits: string[] = [];
    for (const file of files) {
      if (!file.path.startsWith("src/client")) continue;
      if (/\.innerHTML\s*=/.test(file.body)) hits.push(`${file.path}: innerHTML=`);
      if (/\binsertAdjacentHTML\s*\(/.test(file.body)) hits.push(`${file.path}: insertAdjacentHTML`);
      if (/\bdocument\.write\s*\(/.test(file.body)) hits.push(`${file.path}: document.write`);
    }
    expect(hits).toEqual([]);
  });

  it("does not hardcode a Google spreadsheet id", () => {
    // Live spreadsheet keys are long URL-safe tokens, typically 40–50 chars.
    const idLike = /["'`]([a-zA-Z0-9_-]{40,60})["'`]/g;
    const hits: string[] = [];
    for (const file of files) {
      for (const match of file.body.matchAll(idLike)) {
        const token = match[1]!;
        // UUIDs and sha256 hex digests are 32/64 hex — exclude pure hex.
        if (/^[0-9a-fA-F]+$/.test(token)) continue;
        // Base64-ish hashes used in tests can look similar; require mixed case
        // or a leading digit the way Google sheet keys often present.
        if (!/[A-Z]/.test(token) || !/[0-9]/.test(token)) continue;
        hits.push(`${file.path}: ${token}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
