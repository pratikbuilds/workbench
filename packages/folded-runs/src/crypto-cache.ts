// One `CryptoProvider` per cache key, minted once and reused while the
// key stays active — mirroring the per-instance signing-key cache the
// platform's own mail route keeps. A caller picks its own key (a
// workbench id, an instance id, ...); this module knows nothing about
// what the key means. Independent instances mint independent keys for
// the same string, so a host that has several mail senders constructs
// one cache and passes it to each of them.
import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import { createExpiringMap } from "@corbits/collections";
import type { CryptoProvider } from "@intx/types/runtime";

export type CryptoProviderCache = {
  get(key: string): Promise<CryptoProvider>;
};

/** A key untouched for this long is treated as gone for good rather
 * than merely idle: an idle-sleep sweep or a long weekend away is
 * routinely shorter than this, so a re-wake almost never rotates its
 * signing key; only a workbench/instance nobody has come back to in a
 * week does. Re-minting is cheap (one Ed25519 keypair generation) and
 * nothing in this codebase persists or re-checks a signing key's
 * public half against an earlier value, so a rare rotation for a truly
 * abandoned key is not a correctness risk. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createCryptoProviderCache(options?: {
  readonly ttlMs?: number;
  readonly now?: () => number;
}): CryptoProviderCache {
  const providers = createExpiringMap<string, Promise<CryptoProvider>>({
    ttlMs: options?.ttlMs ?? DEFAULT_TTL_MS,
    ...(options?.now !== undefined ? { now: options.now } : {}),
  });

  return {
    get(key: string): Promise<CryptoProvider> {
      const pending = providers.get(key);
      if (pending !== undefined) {
        // Touch the entry so a key in active use never expires out
        // from under it — only a key nobody has asked for within a
        // full ttl window is treated as abandoned.
        providers.set(key, pending);
        return pending;
      }
      const minted = generateKeyPair().then((keyPair) =>
        createEd25519Crypto(keyPair),
      );
      providers.set(key, minted);
      return minted;
    },
  };
}
