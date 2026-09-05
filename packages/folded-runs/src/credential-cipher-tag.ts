// Runtime-checked mint of a CredentialCipher. The composition root
// comments that every secret-at-rest seam shares one real cipher; that
// guarantee is comment-only unless something actually inspects the
// object. This is that inspection: missing or wrong-shape input fails
// closed and the tag is not minted. Callers that persist secrets do not
// re-assert — they take a cipher already tagged here or at hub boot.
import type { CredentialCipher } from "@intx/types";

function isCredentialCipher(value: unknown): value is CredentialCipher {
  if (value === null || typeof value !== "object") return false;
  if (!("encrypt" in value) || !("decrypt" in value)) return false;
  return (
    typeof value.encrypt === "function" && typeof value.decrypt === "function"
  );
}

/**
 * Mints a tagged `CredentialCipher` after a runtime shape check.
 * Missing or wrong-shape input throws — the tag is not produced.
 */
export function tagCredentialCipher(cipher: unknown): CredentialCipher {
  if (!isCredentialCipher(cipher)) {
    throw new Error(
      "credentialCipher is missing or has the wrong shape; refusing to mint a tagged cipher",
    );
  }
  return cipher;
}
