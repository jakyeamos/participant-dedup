import { describe, expect, it } from "vitest";
import { DedupError, isDedupError } from "@/server/errors";

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
