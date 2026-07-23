import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  makePairKey,
  relevantHash,
  rowFingerprint,
  sha256Hex,
} from "@/server/hashing";

describe("sha256Hex", () => {
  it("matches known vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("The quick brown fox jumps over the lazy dog")).toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    );
  });
});

describe("canonicalJson", () => {
  it("sorts object keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: { d: 1, c: 2 }, b: [3, 2] })).toBe(
      '{"a":{"c":2,"d":1},"b":[3,2]}',
    );
  });
});

describe("makePairKey", () => {
  it("is order-independent", () => {
    expect(makePairKey("x", "y")).toBe(makePairKey("y", "x"));
    expect(makePairKey("x", "y")).not.toBe(makePairKey("x", "z"));
  });
});

describe("fingerprints", () => {
  it("rowFingerprint changes when a display value changes", () => {
    const a = rowFingerprint(["First", "Last"], ["A", "b"], ["A", "b"], ["", ""]);
    const b = rowFingerprint(["First", "Last"], ["A", "B"], ["A", "B"], ["", ""]);
    expect(a).not.toBe(b);
  });

  it("relevantHash is stable regardless of key order", () => {
    expect(relevantHash({ b: "1", a: null })).toBe(
      relevantHash({ a: null, b: "1" }),
    );
  });
});
