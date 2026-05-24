import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "crypto";
import {
  wrapDek,
  unwrapDek,
  wrapDekFromBase64url,
  unwrapDekToBase64url,
  _resetKekCache,
} from "@/lib/photo-dek";

function randomKekBase64(): string {
  return randomBytes(32).toString("base64");
}

function dekBase64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("photo-dek", () => {
  const originalKek = process.env.PHOTO_KEK;

  beforeEach(() => {
    process.env.PHOTO_KEK = randomKekBase64();
    _resetKekCache();
  });

  afterEach(() => {
    if (originalKek === undefined) {
      delete process.env.PHOTO_KEK;
    } else {
      process.env.PHOTO_KEK = originalKek;
    }
    _resetKekCache();
  });

  it("round-trips a raw 32-byte DEK", () => {
    const dek = randomBytes(32);
    const wrapped = wrapDek(dek);
    const unwrapped = unwrapDek(wrapped);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it("produces different ciphertexts for the same DEK (random IV)", () => {
    const dek = randomBytes(32);
    expect(wrapDek(dek)).not.toBe(wrapDek(dek));
  });

  it("rejects DEKs of the wrong length", () => {
    expect(() => wrapDek(Buffer.alloc(16))).toThrow(/32 bytes/);
    expect(() => wrapDek(Buffer.alloc(48))).toThrow(/32 bytes/);
  });

  it("throws when PHOTO_KEK is unset", () => {
    delete process.env.PHOTO_KEK;
    _resetKekCache();
    expect(() => wrapDek(randomBytes(32))).toThrow(/PHOTO_KEK is not set/);
  });

  it("throws when PHOTO_KEK is the wrong length", () => {
    process.env.PHOTO_KEK = randomBytes(16).toString("base64");
    _resetKekCache();
    expect(() => wrapDek(randomBytes(32))).toThrow(/must decode to 32 bytes/);
  });

  it("rejects tampered ciphertext (auth tag mismatch)", () => {
    const dek = randomBytes(32);
    const wrapped = wrapDek(dek);
    const tampered = Buffer.from(wrapped, "base64");
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => unwrapDek(tampered.toString("base64"))).toThrow();
  });

  it("refuses to unwrap with a different KEK", () => {
    const dek = randomBytes(32);
    const wrapped = wrapDek(dek);
    // Rotate the KEK and re-load.
    process.env.PHOTO_KEK = randomKekBase64();
    _resetKekCache();
    expect(() => unwrapDek(wrapped)).toThrow();
  });

  describe("base64url helpers", () => {
    it("wrap from base64url + unwrap to base64url round-trips", () => {
      const dek = randomBytes(32);
      const dekStr = dekBase64url(dek);
      const wrapped = wrapDekFromBase64url(dekStr);
      const out = unwrapDekToBase64url(wrapped);
      expect(out).toBe(dekStr);
    });

    it("URL-safe and standard base64 inputs both work", () => {
      const dek = randomBytes(32);
      const standard = dek.toString("base64");
      const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const a = unwrapDekToBase64url(wrapDekFromBase64url(standard));
      const b = unwrapDekToBase64url(wrapDekFromBase64url(urlSafe));
      expect(a).toBe(b);
    });
  });
});
