import * as esbuild from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * G1: produce the clasp-ready `dist/` tree.
 *
 * - `Code.js` — one IIFE of the server, with §6 entry points installed on
 *   `globalThis` at load. No npm runtime, no module loader.
 * - `Sidebar.html` — the template with CSS and the client IIFE inlined, so the
 *   sidebar never fetches a remote asset (§21.8).
 * - `appsscript.json` — copied verbatim from `src/`.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");

function resolveAt(id) {
  const rel = id.slice(2);
  const base = path.join(src, rel);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve ${id}`);
}

/** Maps `@/…` imports the same way vitest and tsc do. */
const aliasPlugin = {
  name: "alias-at",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => ({ path: resolveAt(args.path) }));
  },
};

async function bundle(entry, outfile) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: outfile !== null,
    outfile: outfile ?? undefined,
    format: "iife",
    platform: "neutral",
    target: "es2019",
    // Keep free names (SpreadsheetApp, HtmlService, Sheets, …) unresolved —
    // Apps Script supplies them at runtime.
    plugins: [aliasPlugin],
    logLevel: "silent",
    // Tree-shake the in-memory fake out of the production bundle.
    treeShaking: true,
  });
  if (outfile === null) {
    const file = result.outputFiles?.[0];
    if (!file) throw new Error(`esbuild produced no output for ${entry}`);
    return file.text;
  }
  return "";
}

function buildSidebarHtml(js, css) {
  const template = readFileSync(path.join(src, "client", "Sidebar.template.html"), "utf8");
  if (!template.includes("__SIDEBAR_CSS__") || !template.includes("__SIDEBAR_JS__")) {
    throw new Error("Sidebar.template.html is missing inline placeholders");
  }
  return template
    .replace("/* __SIDEBAR_CSS__ */", css)
    .replace("/* __SIDEBAR_JS__ */", js);
}

async function main() {
  mkdirSync(dist, { recursive: true });

  await bundle(path.join(src, "server", "globals.ts"), path.join(dist, "Code.js"));

  const clientJs = await bundle(path.join(src, "client", "sidebar.ts"), null);
  const clientCss = readFileSync(path.join(src, "client", "sidebar.css"), "utf8");
  writeFileSync(path.join(dist, "Sidebar.html"), buildSidebarHtml(clientJs, clientCss), "utf8");

  copyFileSync(path.join(src, "appsscript.json"), path.join(dist, "appsscript.json"));

  // Fail closed if the server bundle still mentions the fake — that would mean
  // a production import path leaked test infrastructure into clasp.
  const code = readFileSync(path.join(dist, "Code.js"), "utf8");
  if (code.includes("FakeSheetsGateway")) {
    throw new Error("dist/Code.js unexpectedly includes FakeSheetsGateway");
  }
  if (/\bUrlFetchApp\b/.test(code) || /https?:\/\//i.test(code) || /\brequire\s*\(/.test(code)) {
    throw new Error("dist/Code.js failed the network / module-loader gate");
  }

  console.log("built dist/Code.js, dist/Sidebar.html, dist/appsscript.json");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
