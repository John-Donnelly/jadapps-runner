import { describe, it, expect } from "vitest";
import { encryptJson, decryptJson, generateMasterKey } from "../src/credentials/crypto";

describe("crypto", () => {
  it("round-trips an encrypted payload", () => {
    const key = generateMasterKey();
    const plain = { secret: "shh", count: 42, nested: { ok: true } };
    const blob = encryptJson(key, plain);
    expect(typeof blob).toBe("string");
    expect(decryptJson(key, blob)).toEqual(plain);
  });

  it("fails authentication with the wrong key", () => {
    const a = generateMasterKey();
    const b = generateMasterKey();
    const blob = encryptJson(a, { x: 1 });
    expect(() => decryptJson(b, blob)).toThrow();
  });
});
