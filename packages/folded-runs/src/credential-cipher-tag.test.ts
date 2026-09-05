// Tag construction is the one mint that runtime-checks a CredentialCipher's
// shape. Missing or wrong-shape input fails closed — the tag is not minted.
// Persist paths do not re-assert; they consume a tag already minted here
// (or at hub boot).
import { describe, expect, test } from "bun:test";
import { tagCredentialCipher } from "./credential-cipher-tag";

const validCipher = {
  encrypt: async (plaintext: string) => plaintext,
  decrypt: async (blob: string) => blob,
};

describe("tagCredentialCipher", () => {
  test("mints the same object when encrypt and decrypt are functions", () => {
    expect(tagCredentialCipher(validCipher)).toBe(validCipher);
  });

  test("refuses to mint a tag when the cipher is missing", () => {
    expect(() => tagCredentialCipher(undefined)).toThrow(
      /missing or has the wrong shape/,
    );
    expect(() => tagCredentialCipher(null)).toThrow(
      /missing or has the wrong shape/,
    );
  });

  test("refuses to mint a tag when the cipher has the wrong shape", () => {
    expect(() => tagCredentialCipher({})).toThrow(
      /missing or has the wrong shape/,
    );
    expect(() => tagCredentialCipher({ encrypt: async () => "" })).toThrow(
      /missing or has the wrong shape/,
    );
    expect(() => tagCredentialCipher({ decrypt: async () => "" })).toThrow(
      /missing or has the wrong shape/,
    );
    expect(() =>
      tagCredentialCipher({
        encrypt: "not-a-function",
        decrypt: async () => "",
      }),
    ).toThrow(/missing or has the wrong shape/);
    expect(() =>
      tagCredentialCipher({
        encrypt: async () => "",
        decrypt: "not-a-function",
      }),
    ).toThrow(/missing or has the wrong shape/);
  });
});
