/**
 * Synthetic participant fixture generator for autonomous dogfooding.
 *
 * Every name, address, and ZIP is invented — there is NO real participant data
 * here. Distinct identities are given distinct DOB, ZIP, and address so that the
 * only pairs the engine can legitimately match are the ones this generator
 * deliberately seeds, which it also records as ground truth. Deterministic by
 * seed. Run as a script (`pnpm fixture`) to emit a CSV.
 */

export interface GroundTruthGroup {
  ids: string[];
  kind: string;
}

export interface Fixture {
  rows: Array<Record<string, string>>;
  groundTruth: GroundTruthGroup[];
}

export const HEADERS = [
  "_Dedup_ID",
  "First Name",
  "Middle",
  "Last Name",
  "DOB",
  "Address",
  "City",
  "State",
  "ZIP",
] as const;

/** Ground-truth kinds whose intra-group pairs are genuine duplicates. */
export const POSITIVE_KINDS = new Set([
  "EXACT",
  "SWAPPED",
  "TYPO",
  "PLACEHOLDER_DOB",
  "CHANGED_ZIP",
  "TRANSITIVE",
]);

/** Negative-control kinds: intra-group pairs must NOT be judged duplicates. */
export const NEGATIVE_KINDS = new Set(["HOUSEHOLD", "COMMON_SURNAME"]);

// Invented syllable pools — chosen so no combination spells a common real name.
const FIRST_A = ["Zan", "Vex", "Quor", "Bri", "Lume", "Tavi", "Ryn", "Osk", "Pell", "Wyn", "Kesh", "Faro", "Nyl", "Dro"];
const FIRST_B = ["ael", "ova", "iri", "usk", "ent", "yra", "ola", "ix", "arn", "eth", "ulo", "yss"];
const LAST_A = ["Bram", "Corv", "Dulm", "Esta", "Farr", "Glen", "Hald", "Ilm", "Jorv", "Kess", "Lomr", "Mert", "Ostr", "Pral"];
const LAST_B = ["ock", "ane", "ar", "eby", "oweth", "var", "ren", "ore", "ath", "win", "ick", "and", "ell", "oon"];
const STREETS = ["Aldercroft", "Brindlewood", "Cindervale", "Duskmere", "Everwynd", "Fallowgate", "Grimsby Reach", "Hollowmoor", "Ironvale", "Juniper Hollow"];
const STREET_TYPES = ["St", "Ave", "Rd", "Ln", "Way"];
const CITIES = ["Wexbury", "Karnhollow", "Orindale", "Pelmoor", "Tavenport", "Yssmarch"];
const STATES = ["MA", "NY", "CA", "TX", "OH", "WA"];
const COMMON_SURNAMES = ["Vantry", "Ostrand", "Merrow"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Builder {
  private rng: () => number;
  private counter = 0;
  private usedNames = new Set<string>();
  private dobDay = 0;
  private zipNum = 10000;
  private houseNum = 100;
  readonly rows: Array<Record<string, string>> = [];
  readonly groundTruth: GroundTruthGroup[] = [];

  constructor(
    private seed: number,
    rng: () => number,
  ) {
    this.rng = rng;
  }

  private pick<T>(pool: readonly T[]): T {
    return pool[Math.floor(this.rng() * pool.length)]!;
  }

  private cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private uniqueName(surname?: string): { first: string; last: string } {
    for (let attempt = 0; attempt < 50; attempt++) {
      const first = this.cap(this.pick(FIRST_A).toLowerCase() + this.pick(FIRST_B));
      const last = surname ?? this.cap(this.pick(LAST_A).toLowerCase() + this.pick(LAST_B));
      const key = `${first}|${last}`;
      if (surname !== undefined || !this.usedNames.has(key)) {
        this.usedNames.add(key);
        return { first, last };
      }
    }
    // Deterministic fallback keeps names unique without digits in the surname.
    const first = this.cap(this.pick(FIRST_A).toLowerCase() + this.pick(FIRST_B));
    const last = surname ?? this.cap(this.pick(LAST_A).toLowerCase() + this.pick(LAST_B) + this.pick(LAST_B));
    this.usedNames.add(`${first}|${last}`);
    return { first, last };
  }

  private nextDob(): string {
    this.dobDay += 1 + Math.floor(this.rng() * 3);
    const base = new Date(Date.UTC(1955, 0, 1));
    base.setUTCDate(base.getUTCDate() + this.dobDay);
    return `${base.getUTCMonth() + 1}/${base.getUTCDate()}/${base.getUTCFullYear()}`;
  }

  private nextZip(): string {
    this.zipNum += 1 + Math.floor(this.rng() * 4);
    return String(this.zipNum).padStart(5, "0");
  }

  private nextAddress(): string {
    this.houseNum += 2 + Math.floor(this.rng() * 6);
    return `${this.houseNum} ${this.pick(STREETS)} ${this.pick(STREET_TYPES)}`;
  }

  private nextId(): string {
    this.counter += 1;
    return `F${this.seed}-${String(this.counter).padStart(6, "0")}`;
  }

  private emit(fields: Omit<Record<string, string>, "_Dedup_ID">): string {
    const id = this.nextId();
    this.rows.push({ "_Dedup_ID": id, ...fields });
    return id;
  }

  private basePerson(surname?: string): Record<string, string> {
    const { first, last } = this.uniqueName(surname);
    return {
      "First Name": first,
      Middle: "",
      "Last Name": last,
      DOB: this.nextDob(),
      Address: this.nextAddress(),
      City: this.pick(CITIES),
      State: this.pick(STATES),
      ZIP: this.nextZip(),
    };
  }

  private typo(token: string): string {
    if (token.length < 4) return token + token.charAt(token.length - 1);
    const i = 1 + Math.floor(this.rng() * (token.length - 2));
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    let repl = alphabet[Math.floor(this.rng() * 26)]!;
    if (repl === token[i]!.toLowerCase()) repl = repl === "z" ? "a" : "z";
    return token.slice(0, i) + repl + token.slice(i + 1);
  }

  addSingleton(): void {
    this.emit(this.basePerson());
  }

  addPositive(kind: string): void {
    const base = this.basePerson();
    const ids: string[] = [this.emit(base)];

    if (kind === "EXACT") {
      ids.push(this.emit({ ...base }));
    } else if (kind === "SWAPPED") {
      ids.push(this.emit({ ...base, "First Name": base["Last Name"]!, "Last Name": base["First Name"]! }));
    } else if (kind === "TYPO") {
      ids.push(this.emit({ ...base, "Last Name": this.typo(base["Last Name"]!) }));
    } else if (kind === "PLACEHOLDER_DOB") {
      const a = { ...base, DOB: "1/1/1900" };
      // Rewrite the already-emitted row's DOB to the placeholder too.
      this.rows[this.rows.length - 1]!["DOB"] = "1/1/1900";
      ids.push(this.emit({ ...a }));
    } else if (kind === "CHANGED_ZIP") {
      ids.push(this.emit({ ...base, Address: this.nextAddress(), ZIP: this.nextZip() }));
    } else if (kind === "TRANSITIVE") {
      ids.push(this.emit({ ...base })); // exact
      ids.push(this.emit({ ...base, "Last Name": this.typo(base["Last Name"]!) })); // typo
    }
    this.groundTruth.push({ ids, kind });
  }

  addHousehold(): void {
    const shared = this.basePerson();
    const address = shared["Address"]!;
    const zip = shared["ZIP"]!;
    const surname = shared["Last Name"]!;
    const ids: string[] = [this.emit(shared)];
    const other = this.basePerson(surname);
    ids.push(this.emit({ ...other, Address: address, ZIP: zip }));
    this.groundTruth.push({ ids, kind: "HOUSEHOLD" });
  }

  addCommonSurname(members: number): void {
    const surname = this.pick(COMMON_SURNAMES);
    const ids: string[] = [];
    for (let i = 0; i < members; i++) ids.push(this.emit(this.basePerson(surname)));
    this.groundTruth.push({ ids, kind: "COMMON_SURNAME" });
  }
}

export function generateFixture(seed: number, rows = 5000): Fixture {
  const rng = mulberry32(seed);
  const b = new Builder(seed, rng);

  const positiveKinds = ["EXACT", "SWAPPED", "TYPO", "PLACEHOLDER_DOB", "CHANGED_ZIP"];
  const pGroups = Math.max(6, Math.round(rows * 0.05));
  const tGroups = Math.max(2, Math.round(pGroups * 0.1));
  const hPairs = Math.max(4, Math.round(rows * 0.03));
  const cGroups = Math.max(2, Math.round(rows * 0.006));

  for (let i = 0; i < pGroups; i++) b.addPositive(positiveKinds[i % positiveKinds.length]!);
  for (let i = 0; i < tGroups; i++) b.addPositive("TRANSITIVE");
  for (let i = 0; i < hPairs; i++) b.addHousehold();
  for (let i = 0; i < cGroups; i++) b.addCommonSurname(3 + (i % 3));

  while (b.rows.length < rows) b.addSingleton();
  // Trim any overshoot from the final singleton loop (rows already >= target here
  // only when patterns alone exceeded the target, which the callers avoid).
  const trimmed = b.rows.slice(0, rows);

  return { rows: trimmed, groundTruth: b.groundTruth };
}

async function main(): Promise<void> {
  const seed = Number(process.argv[2] ?? 1);
  const count = Number(process.argv[3] ?? 5000);
  const { rows, groundTruth } = generateFixture(seed, count);
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const escape = (v: string): string =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const csv = [
    HEADERS.join(","),
    ...rows.map((r) => HEADERS.map((h) => escape(r[h] ?? "")).join(",")),
  ].join("\n");
  const out = "tools/out/fixture.csv";
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, csv, "utf8");
  process.stdout.write(
    `Wrote ${rows.length} rows and ${groundTruth.length} ground-truth groups to ${out}\n`,
  );
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("generateFixture.ts") || invokedPath.endsWith("generateFixture.js")) {
  void main();
}
