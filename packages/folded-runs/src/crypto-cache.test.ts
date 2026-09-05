import { describe, expect, test } from "bun:test";
import { createCryptoProviderCache } from "./crypto-cache";

/** A controllable clock: advances only when the test tells it to, so
 * eviction timing is asserted exactly rather than raced against a real
 * timer. */
function fakeClock(startAt = 0) {
  let now = startAt;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("createCryptoProviderCache", () => {
  test("reuses the same provider for a key accessed within its ttl", async () => {
    const clock = fakeClock();
    const cache = createCryptoProviderCache({ ttlMs: 1_000, now: clock.now });

    const first = await cache.get("workbench-1");
    clock.advance(999);
    const second = await cache.get("workbench-1");

    expect(second).toBe(first);
  });

  test("mints a fresh provider once a key has gone untouched past its ttl", async () => {
    const clock = fakeClock();
    const cache = createCryptoProviderCache({ ttlMs: 1_000, now: clock.now });

    const first = await cache.get("workbench-1");
    clock.advance(1_000);
    const second = await cache.get("workbench-1");

    expect(second).not.toBe(first);
    expect(second.getPublicKey()).not.toEqual(first.getPublicKey());
  });

  test("an access refreshes the ttl, so a key in steady use never expires", async () => {
    const clock = fakeClock();
    const cache = createCryptoProviderCache({ ttlMs: 1_000, now: clock.now });

    const first = await cache.get("workbench-1");
    clock.advance(600);
    await cache.get("workbench-1"); // refreshes the ttl
    clock.advance(600);
    const third = await cache.get("workbench-1");

    // 1200ms since the first access, but only 600ms since the refresh.
    expect(third).toBe(first);
  });

  test("distinct keys mint distinct providers", async () => {
    const cache = createCryptoProviderCache();

    const a = await cache.get("workbench-1");
    const b = await cache.get("workbench-2");

    expect(a).not.toBe(b);
    expect(a.getPublicKey()).not.toEqual(b.getPublicKey());
  });

  test("independent caches mint different providers for the same key", async () => {
    const first = createCryptoProviderCache();
    const second = createCryptoProviderCache();

    const a = await first.get("run_same");
    const b = await second.get("run_same");

    expect(a).not.toBe(b);
    expect(a.getPublicKey()).not.toEqual(b.getPublicKey());
  });

  test("one shared cache returns the same provider to every consumer of a key", async () => {
    const cache = createCryptoProviderCache();

    const chat = await cache.get("run_same");
    const webhook = await cache.get("run_same");
    const routine = await cache.get("run_same");
    const drafting = await cache.get("run_same");

    expect(webhook).toBe(chat);
    expect(routine).toBe(chat);
    expect(drafting).toBe(chat);
  });
});
