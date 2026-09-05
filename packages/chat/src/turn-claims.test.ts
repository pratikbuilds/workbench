import { describe, expect, test } from "bun:test";
import { createInMemoryTurnClaimStore } from "./turn-claims";

describe("createInMemoryTurnClaimStore", () => {
  test("the first tryClaim for a workbench wins, returning a token", async () => {
    const store = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    const token = await store.tryClaim({ workbenchId: "wb_1" });
    expect(typeof token).toBe("string");
  });

  test("a second tryClaim for the same workbench loses while the first is held", async () => {
    const store = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    await store.tryClaim({ workbenchId: "wb_1" });
    await expect(store.tryClaim({ workbenchId: "wb_1" })).resolves.toBe(false);
  });

  test("claims on different workbenches never contend", async () => {
    const store = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    await expect(store.tryClaim({ workbenchId: "wb_1" })).resolves.not.toBe(
      false,
    );
    await expect(store.tryClaim({ workbenchId: "wb_2" })).resolves.not.toBe(
      false,
    );
  });

  test("release frees the claim for a fresh tryClaim", async () => {
    const store = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    const token = await store.tryClaim({ workbenchId: "wb_1" });
    await expect(
      store.release({ workbenchId: "wb_1" }, token as string),
    ).resolves.toBe(true);
    await expect(store.tryClaim({ workbenchId: "wb_1" })).resolves.not.toBe(
      false,
    );
  });

  test("releasing a claim nobody holds is a harmless no-op", async () => {
    const store = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
    await expect(
      store.release({ workbenchId: "wb_never_claimed" }, "some_token"),
    ).resolves.toBe(false);
  });

  test("releasing with a stale token — one the TTL already reassigned — is a no-op", async () => {
    let now = 0;
    const store = createInMemoryTurnClaimStore({
      ttlMs: 1_000,
      now: () => now,
    });
    const firstToken = await store.tryClaim({ workbenchId: "wb_1" });
    now += 1_000; // the TTL elapses while the first holder is still "in flight"
    const secondToken = await store.tryClaim({ workbenchId: "wb_1" });
    expect(secondToken).not.toBe(false);
    expect(secondToken).not.toBe(firstToken);

    // The first holder's `finally` releasing its now-stale token must
    // never evict the second holder's live claim.
    await expect(
      store.release({ workbenchId: "wb_1" }, firstToken as string),
    ).resolves.toBe(false);
    await expect(
      store.holds({ workbenchId: "wb_1" }, secondToken as string),
    ).resolves.toBe(true);
  });

  test("a mismatched release evicts an already-expired entry, so the true original token then finds nothing left to release", async () => {
    let now = 0;
    const store = createInMemoryTurnClaimStore({
      ttlMs: 1_000,
      now: () => now,
    });
    const token = await store.tryClaim({ workbenchId: "wb_1" });
    now += 1_000; // expired, but nobody has claimed it since

    // A release with the wrong token still can't claim credit for
    // freeing this workbench, but it notices the stale entry it found
    // along the way and cleans it up rather than leaving it in place.
    await expect(
      store.release({ workbenchId: "wb_1" }, "not_the_real_token"),
    ).resolves.toBe(false);

    // Proof the entry is actually gone, not merely ignored: the true
    // original token — still technically correct — now finds nothing
    // left to release.
    await expect(
      store.release({ workbenchId: "wb_1" }, token as string),
    ).resolves.toBe(false);
  });

  test("a claim older than the TTL is reclaimable even without release — the crash/hang backstop", async () => {
    let now = 0;
    const store = createInMemoryTurnClaimStore({
      ttlMs: 1_000,
      now: () => now,
    });
    await store.tryClaim({ workbenchId: "wb_1" });
    now += 999;
    await expect(store.tryClaim({ workbenchId: "wb_1" })).resolves.toBe(false);
    now += 2;
    await expect(store.tryClaim({ workbenchId: "wb_1" })).resolves.not.toBe(
      false,
    );
  });

  describe("holds", () => {
    test("is true for the current, unexpired holder's own token", async () => {
      const store = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
      const token = await store.tryClaim({ workbenchId: "wb_1" });
      await expect(
        store.holds({ workbenchId: "wb_1" }, token as string),
      ).resolves.toBe(true);
    });

    test("is false for a token nobody ever held", async () => {
      const store = createInMemoryTurnClaimStore({ ttlMs: 60_000 });
      await expect(
        store.holds({ workbenchId: "wb_1" }, "never_claimed"),
      ).resolves.toBe(false);
    });

    test("is false once the TTL expires, even without a fresh tryClaim", async () => {
      let now = 0;
      const store = createInMemoryTurnClaimStore({
        ttlMs: 1_000,
        now: () => now,
      });
      const token = await store.tryClaim({ workbenchId: "wb_1" });
      now += 1_000;
      await expect(
        store.holds({ workbenchId: "wb_1" }, token as string),
      ).resolves.toBe(false);
    });

    test("observing an expired claim deletes it, so the original token then finds nothing to release", async () => {
      let now = 0;
      const store = createInMemoryTurnClaimStore({
        ttlMs: 1_000,
        now: () => now,
      });
      const token = await store.tryClaim({ workbenchId: "wb_1" });
      now += 1_000;
      await expect(
        store.holds({ workbenchId: "wb_1" }, token as string),
      ).resolves.toBe(false);
      await expect(
        store.release({ workbenchId: "wb_1" }, token as string),
      ).resolves.toBe(false);
    });
  });
});
