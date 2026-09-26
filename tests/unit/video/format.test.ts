import { describe, expect, it } from "vitest";
import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { sealObject, openObject, context } from "@/lib/video/format";
const identity = { asset: randomUUID(), version: randomUUID(), attempt: randomUUID(), name: "segment-0-00001.m4s" };
describe("PPV1 encrypted source and output objects", () => {
  it("interoperates with browser Web Crypto using independent derivation", async () => {
    const root = randomBytes(32), plain = Buffer.from("fragment bytes");
    for (const name of [identity.name, "source-000000.bin", "play.mpd", "catalog.json", "init-1.mp4"]) {
      const id = { ...identity, name }, encrypted = sealObject(root, id, plain);
      const imported = await webcrypto.subtle.importKey("raw", new Uint8Array(root), "HKDF", false, ["deriveKey"]);
      const key = await webcrypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(id.version), info: new Uint8Array(context(id)) }, imported, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      const decoded = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(encrypted.subarray(4, 16)), additionalData: new Uint8Array(context(id)), tagLength: 128 }, key, new Uint8Array(encrypted.subarray(16)));
      expect(Buffer.from(decoded)).toEqual(plain);
    }
  });
  it("binds attempts, asset, version and source/output identity, with fresh IVs", () => {
    const root = randomBytes(32), plain = Buffer.from("content"), encrypted = sealObject(root, identity, plain);
    for (const id of [{ ...identity, attempt: randomUUID() }, { ...identity, asset: randomUUID() }, { ...identity, version: randomUUID() }, { ...identity, name: "source-000000.bin" }]) expect(() => openObject(root, id, encrypted)).toThrow();
    expect(sealObject(root, identity, plain)).not.toEqual(encrypted);
    expect(() => openObject(randomBytes(32), identity, encrypted)).toThrow();
  });
  it("rejects every altered byte, truncation and invalid name before releasing plaintext", () => {
    const root = randomBytes(32), encrypted = sealObject(root, identity, Buffer.from("video"));
    for (let i = 0; i < encrypted.length; i++) {
      const altered = Buffer.from(encrypted); altered[i] ^= 1;
      expect(() => openObject(root, identity, altered)).toThrow();
      expect(() => openObject(root, identity, encrypted.subarray(0, i))).toThrow();
    }
    expect(() => sealObject(root, { ...identity, name: "../source.bin" }, Buffer.from("x"))).toThrow();
  });
});
