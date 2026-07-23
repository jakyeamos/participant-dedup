import { describe, expect, it } from "vitest";
import { DedupError, isDedupError, isRetryable, safeMessageFor } from "@/server/errors";

describe("DedupError", () => {
  it("carries the code and a safe message derived from it", () => {
    const err = new DedupError("STALE_ROW");
    expect(err.code).toBe("STALE_ROW");
    expect(err.safeMessage).toBe(err.message);
    expect(err.safeMessage.length).toBeGreaterThan(0);
  });

  it("isDedupError narrows only DedupError instances", () => {
    expect(isDedupError(new DedupError("INTERNAL"))).toBe(true);
    expect(isDedupError(new Error("plain"))).toBe(false);
    expect(isDedupError(null)).toBe(false);
  });
});

describe("isRetryable", () => {
  it("marks contention and unexpected failures as worth retrying unchanged", () => {
    expect(isRetryable("LOCK_TIMEOUT")).toBe(true);
    expect(isRetryable("INTERNAL")).toBe(true);
  });

  it("refuses to retry anything the reviewer must resolve first", () => {
    for (const code of [
      "STALE_ROW",
      "REVISION_CONFLICT",
      "NOT_CONFIRMED",
      "DUPLICATE_APPLY",
      "SCHEMA_CHANGED",
      "MISSING_REVIEWER_IDENTITY",
      "BATCH_NOT_FOUND",
    ] as const) {
      expect(isRetryable(code), code).toBe(false);
    }
  });
});

describe("safeMessageFor", () => {
  it("gives the same wording the thrown error carries", () => {
    expect(safeMessageFor("LOCK_TIMEOUT")).toBe(new DedupError("LOCK_TIMEOUT").message);
  });
});
