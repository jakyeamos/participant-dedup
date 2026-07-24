import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * §2 / §31: no real participant identity belongs in the repository. Fixtures
 * and tests use invented names (or the deliberate "Placeholder" surname in
 * sidebar render fixtures). This denylist catches common real-world full names
 * that would indicate a copy-paste from a live sheet.
 *
 * Names are stored as pairs so this file itself does not contain the forbidden
 * full-name strings the scan looks for.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const REAL_NAME_PARTS: ReadonlyArray<readonly [string, string]> = [
  ["John", "Smith"],
  ["Jane", "Smith"],
  ["John", "Doe"],
  ["Jane", "Doe"],
  ["Mary", "Johnson"],
  ["James", "Williams"],
  ["Robert", "Brown"],
  ["Michael", "Davis"],
  ["William", "Miller"],
  ["David", "Wilson"],
  ["Jennifer", "Garcia"],
  ["Elizabeth", "Martinez"],
  ["Richard", "Anderson"],
  ["Thomas", "Taylor"],
  ["Charles", "Thomas"],
  ["Christopher", "Moore"],
  ["Daniel", "Jackson"],
  ["Matthew", "White"],
  ["Anthony", "Harris"],
  ["Mark", "Thompson"],
  ["Steven", "Martinez"],
  ["Paul", "Robinson"],
  ["Andrew", "Clark"],
  ["Joshua", "Rodriguez"],
  ["Kenneth", "Lewis"],
  ["Kevin", "Lee"],
  ["Brian", "Walker"],
  ["George", "Hall"],
  ["Timothy", "Allen"],
  ["Edward", "Hernandez"],
  ["Jason", "King"],
  ["Jeffrey", "Wright"],
  ["Ryan", "Lopez"],
  ["Jacob", "Hill"],
  ["Gary", "Scott"],
  ["Nicholas", "Green"],
  ["Eric", "Adams"],
  ["Jonathan", "Baker"],
  ["Stephen", "Gonzalez"],
  ["Larry", "Nelson"],
  ["Justin", "Carter"],
  ["Scott", "Mitchell"],
  ["Brandon", "Perez"],
  ["Benjamin", "Roberts"],
  ["Samuel", "Turner"],
  ["Raymond", "Phillips"],
  ["Gregory", "Campbell"],
  ["Frank", "Parker"],
  ["Alexander", "Evans"],
  ["Patrick", "Edwards"],
  ["Jack", "Collins"],
  ["Dennis", "Stewart"],
  ["Jerry", "Sanchez"],
  ["Tyler", "Morris"],
  ["Aaron", "Rogers"],
  ["Jose", "Reed"],
  ["Adam", "Cook"],
  ["Nathan", "Morgan"],
  ["Henry", "Bell"],
  ["Zachary", "Murphy"],
  ["Douglas", "Bailey"],
  ["Peter", "Rivera"],
  ["Kyle", "Cooper"],
  ["Noah", "Richardson"],
  ["Ethan", "Cox"],
  ["Jeremy", "Howard"],
  ["Walter", "Ward"],
  ["Christian", "Torres"],
  ["Keith", "Peterson"],
  ["Roger", "Gray"],
  ["Terry", "Ramirez"],
  ["Austin", "James"],
  ["Sean", "Watson"],
  ["Gerald", "Brooks"],
  ["Carl", "Kelly"],
  ["Dylan", "Sanders"],
  ["Harold", "Price"],
  ["Arthur", "Bennett"],
  ["Lawrence", "Wood"],
  ["Bryan", "Barnes"],
  ["Joe", "Ross"],
  ["Billy", "Henderson"],
  ["Albert", "Coleman"],
  ["Bruce", "Jenkins"],
  ["Willie", "Perry"],
  ["Gabriel", "Powell"],
  ["Alan", "Long"],
  ["Juan", "Patterson"],
  ["Wayne", "Hughes"],
  ["Randy", "Flores"],
  ["Eugene", "Washington"],
  ["Russell", "Butler"],
  ["Vincent", "Simmons"],
  ["Philip", "Foster"],
  ["Bobby", "Gonzales"],
  ["Johnny", "Bryant"],
  ["Howard", "Alexander"],
];

const REAL_NAME_DENYLIST = REAL_NAME_PARTS.map(([first, last]) => `${first} ${last}`);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|mjs|csv|md|json|html)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("static: no real participant names (§2)", () => {
  it("keeps the denylist out of src/, test/, and tools/", () => {
    const roots = [join(ROOT, "src"), join(ROOT, "test"), join(ROOT, "tools")];
    const hits: string[] = [];

    for (const root of roots) {
      for (const file of walk(root)) {
        // This file holds the pairs; it must not be scanned for the joined form.
        if (file.endsWith(`${join("static", "noPii.test.ts")}`)) continue;
        const body = readFileSync(file, "utf8");
        for (const name of REAL_NAME_DENYLIST) {
          if (body.includes(name)) hits.push(`${relative(ROOT, file)}: ${name}`);
        }
      }
    }

    expect(hits).toEqual([]);
  });
});
