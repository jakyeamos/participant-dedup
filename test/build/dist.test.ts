import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * G1: the clasp-ready artifact. Built by `pnpm build`; this file only asserts
 * the properties Apps Script and §31 need — a single Code.js with the allowlisted
 * globals, no module loader, no network surface, and a Sidebar.html that ships
 * its own CSS/JS with no remote assets.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CODE = `${ROOT}/dist/Code.js`;
const SIDEBAR = `${ROOT}/dist/Sidebar.html`;
const MANIFEST = `${ROOT}/dist/appsscript.json`;

describe("dist/ artifact", () => {
  it("emits Code.js, Sidebar.html and appsscript.json", () => {
    expect(existsSync(CODE), "run `pnpm build` first").toBe(true);
    expect(existsSync(SIDEBAR), "run `pnpm build` first").toBe(true);
    expect(existsSync(MANIFEST), "run `pnpm build` first").toBe(true);
  });

  it("exposes onOpen and keeps the bundle free of module loaders and network APIs", () => {
    const source = readFileSync(CODE, "utf8");

    expect(source).toMatch(/\bfunction\s+onOpen\b|\bonOpen\s*=/);
    expect(source).not.toMatch(/\bimport\s*[\({]/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bUrlFetchApp\b/);
    // A bare `http` substring would also catch comments; forbid the protocol forms.
    expect(source).not.toMatch(/https?:\/\//i);
  });

  it("inlines the sidebar with no remote stylesheets or scripts", () => {
    const html = readFileSync(SIDEBAR, "utf8");

    expect(html).toContain('id="app"');
    expect(html).toContain("__DEDUP_BOOT__");
    expect(html).toContain("<?!= boot ?>");
    expect(html).not.toMatch(/\bsrc\s*=\s*["']https?:\/\//i);
    expect(html).not.toMatch(/\bhref\s*=\s*["']https?:\/\//i);
    // Placeholders must have been replaced with real assets.
    expect(html).not.toContain("__SIDEBAR_CSS__");
    expect(html).not.toContain("__SIDEBAR_JS__");
    expect(html).toMatch(/\.dd-view\b/);
    expect(html).toMatch(/mountSidebar|__DEDUP_BOOT__/);
  });
});
