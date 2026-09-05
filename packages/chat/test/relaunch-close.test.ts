// The two halves of a relaunch a reader actually experiences: the
// notice that tells them the turn they were waiting on was lost, and
// an attachment they sent BEFORE the crash still opening afterwards.
//
// Both hang off the same fact — a relaunch mints a fresh run with a
// fresh principal, and a folded run's mail session hangs off its
// principal — so the live run cannot see the retired run's mail at all
// unless something walks back through the history.
//
// The fake below serves `agent_session` by the one-session-per-run-
// principal invariant `resolveRunSessionId` reads, so a retired run's
// session really is a different session — which is the only reason
// this test can fail.
import { describe, expect, test } from "bun:test";
import { createCryptoProviderCache } from "@corbits/folded-runs";
import { agentSession } from "@intx/db/schema";
import { workbenchLaunch } from "../src/schema";
import { createHubChatPlatform } from "../src/platform-adapter";
import {
  createRelaunchNoticePoster,
  relaunchNoticeText,
} from "../src/relaunch-notice";

const FOLDED_BODY = {
  systemPrompt: "be helpful",
  toolPackagePins: [],
  grantRequirements: [],
  credentialBindings: [],
  model: null,
};

/** Every string a drizzle `eq`/`and` predicate compares against, in order. */
function comparedValues(node: unknown): string[] {
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (chunks === undefined) {
    const value = (node as { value?: unknown }).value;
    return typeof value === "string" ? [value] : [];
  }
  return chunks.flatMap(comparedValues);
}

type RunRow = {
  id: string;
  tenantId: string;
  definitionId: string | null;
  principalId: string | null;
  address: string | null;
  status: string;
};

type MailRow = { id: string; sessionId: string; raw: Uint8Array };

function createFakeDb(opts: {
  launch: {
    tenantId: string;
    instanceId: string;
    currentRunId: string;
    priorRunIds: string[];
    foldedBody: unknown;
    noopInference: boolean;
  };
  runs: RunRow[];
  mail: MailRow[];
}) {
  return {
    query: {
      workflowRun: {
        findFirst: async ({ where }: { where: unknown }) => {
          const [id] = comparedValues(where);
          return opts.runs.find((run) => run.id === id);
        },
      },
      sessionMail: {
        findFirst: async ({ where }: { where: unknown }) => {
          const [id, sessionId] = comparedValues(where);
          return opts.mail.find(
            (row) => row.id === id && row.sessionId === sessionId,
          );
        },
      },
    },
    select: () => ({
      from: (table: unknown) => ({
        where: (predicate: unknown) => {
          const chain = {
            orderBy: () => chain,
            limit: async () => {
              const [value] = comparedValues(predicate);
              // One session per run principal — the invariant
              // `resolveRunSessionId` reads, which is exactly what makes
              // a fresh run's session a DIFFERENT session.
              if (table === agentSession) {
                return opts.runs.some((run) => run.principalId === value)
                  ? [{ id: `ses_${value ?? ""}` }]
                  : [];
              }
              if (table !== workbenchLaunch) return [];
              return value === opts.launch.instanceId ||
                value === opts.launch.currentRunId
                ? [opts.launch]
                : [];
            },
          };
          return chain;
        },
      }),
    }),
  } as never;
}

function createPlatform(db: never) {
  return createHubChatPlatform({
    db,
    toolGrantsForPins: () => [],
    sessionService: {} as never,
    assetService: {} as never,
    sidecarRouter: { getRoutableAddresses: () => [] } as never,
    eventCollectors: {} as never,
    cryptoProviders: createCryptoProviderCache(),
    credentialCipher: {
      encrypt: async (plaintext: string) => plaintext,
      decrypt: async (blob: string) => blob,
    },
  });
}

const RAW_MAIL = new TextEncoder().encode(
  [
    "Content-Type: multipart/mixed; boundary=b",
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "the receipt you asked for",
    "--b--",
    "",
  ].join("\r\n"),
);

describe("fetchBlob across a relaunch", () => {
  const RELAUNCHED_LAUNCH = {
    tenantId: "ten_1",
    instanceId: "ins_room1",
    currentRunId: "run_fresh",
    priorRunIds: ["run_dead"],
    foldedBody: FOLDED_BODY,
    noopInference: false,
  };
  const RUNS: RunRow[] = [
    {
      id: "run_fresh",
      tenantId: "ten_1",
      definitionId: "wfd_1",
      principalId: "prin_fresh",
      address: "run_fresh@ten1.workbench.test",
      status: "running",
    },
    {
      id: "run_dead",
      tenantId: "ten_1",
      definitionId: "wfd_1",
      principalId: "prin_dead",
      address: "run_dead@ten1.workbench.test",
      status: "failed",
    },
  ];

  test("reads an attachment sent before the crash, off the retired run's session", async () => {
    const db = createFakeDb({
      launch: RELAUNCHED_LAUNCH,
      runs: RUNS,
      mail: [{ id: "mail_1", sessionId: "ses_prin_dead", raw: RAW_MAIL }],
    });

    const body = await createPlatform(db).fetchBlob(
      "ins_room1",
      "blob_mail_1_1",
    );

    expect(new TextDecoder().decode(body as Uint8Array)).toContain(
      "the receipt you asked for",
    );
  });

  test("a blob on no session this participant ever held is still refused", async () => {
    const db = createFakeDb({
      launch: RELAUNCHED_LAUNCH,
      runs: RUNS,
      mail: [{ id: "mail_1", sessionId: "ses_prin_stranger", raw: RAW_MAIL }],
    });

    await expect(
      createPlatform(db).fetchBlob("ins_room1", "blob_mail_1_1"),
    ).rejects.toThrow('No mail "mail_1"');
  });

  test("a retired run whose row is gone is skipped, not fatal", async () => {
    const db = createFakeDb({
      launch: {
        ...RELAUNCHED_LAUNCH,
        priorRunIds: ["run_reaped", "run_dead"],
      },
      runs: RUNS,
      mail: [{ id: "mail_1", sessionId: "ses_prin_dead", raw: RAW_MAIL }],
    });

    const body = await createPlatform(db).fetchBlob(
      "ins_room1",
      "blob_mail_1_1",
    );

    expect(new TextDecoder().decode(body as Uint8Array)).toContain(
      "the receipt you asked for",
    );
  });
});

describe("relaunchNoticeText", () => {
  test("names the cause the reader experienced, never the machinery", () => {
    const crashed = relaunchNoticeText("failed");
    const cancelled = relaunchNoticeText("cancelled");
    const ended = relaunchNoticeText("completed");

    expect(crashed).not.toBe(cancelled);
    expect(cancelled).not.toBe(ended);
    for (const notice of [crashed, cancelled, ended]) {
      expect(notice).toContain("I'm back now");
      expect(notice.toLowerCase()).not.toContain("run");
      expect(notice.toLowerCase()).not.toContain("terminal");
      expect(notice.toLowerCase()).not.toContain("relaunch");
    }
  });
});

describe("createRelaunchNoticePoster", () => {
  function createRoom(participantAddresses: string[][]) {
    const posted: {
      workbenchId: string;
      senderAddress: string;
      text: string;
    }[] = [];
    const store = {
      listWorkbenchSettings: async () =>
        participantAddresses.map((addresses, index) => ({
          workbenchId: `wb_${String(index)}`,
          settings: {
            "chat/participants": addresses.map((address) => ({
              address,
              handle: address.split("@")[0],
              name: null,
              kind: "agent",
            })),
          },
        })),
    };
    const roomMessages = {
      insertMessage: async (input: {
        id: string;
        workbenchId: string;
        sender: { address: string };
        parts: { kind: string; text: string }[];
      }) => {
        posted.push({
          workbenchId: input.workbenchId,
          senderAddress: input.sender.address,
          text: input.parts[0]?.text ?? "",
        });
        return {
          ...input,
          createdAt: "2026-08-20T00:00:00.000Z",
          threadId: null,
        };
      },
    };
    return { posted, store, roomMessages };
  }

  test("posts into every room the replaced participant belongs to, in its own voice", async () => {
    const room = createRoom([
      ["ins_room1@ten1.workbench.test"],
      ["ins_other@ten1.workbench.test"],
      ["ins_room1@ten1.workbench.test", "ins_other@ten1.workbench.test"],
    ]);
    const poster = createRelaunchNoticePoster({
      store: room.store as never,
      roomMessages: room.roomMessages as never,
      publish: () => undefined,
    });

    poster({
      tenantId: "ten_1",
      roomAddress: "ins_room1@ten1.workbench.test",
      deadRunId: "run_dead",
      deadRunStatus: "failed",
      newRunId: "run_fresh",
    });
    await Bun.sleep(5);

    expect(room.posted).toEqual([
      {
        workbenchId: "wb_0",
        senderAddress: "ins_room1@ten1.workbench.test",
        text: relaunchNoticeText("failed"),
      },
      {
        workbenchId: "wb_2",
        senderAddress: "ins_room1@ten1.workbench.test",
        text: relaunchNoticeText("failed"),
      },
    ]);
  });
});
