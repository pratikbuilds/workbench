// Static-markup rendering for the chat surface's pieces, following the same
// convention as test/pages.test.tsx: no live backing, fixture props in,
// honest markup out.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { MessageItem } from "../src/api";
import { Composer } from "../src/composer";
import { profileSubjectFromParticipant } from "../src/profile-subject";
import { renamePayload, rowMenuLabels } from "../src/sidebar";
import {
  isTypingStateExpired,
  nextTypingState,
  parseTypingEvent,
  typingLabel,
  TypingIndicator,
} from "../src/typing-indicator";

import { WorkbenchTimeline } from "../src/timeline";
/** The floor: no rendered text may ever contain a raw identifier. */
const RAW_ID_PATTERN = /\b(prn_|ins_|tnt_)[a-z0-9]/i;

/** The composer's slash-command hops — a no-op stand-in for these
 * render-only tests, which never trigger them. */
const composerSlashHandlers = {
  onInviteAgent: () => {},
  onOpenAgentsSettings: () => {},
  onCreateRoutineInSpace: () => {},
};

describe("WorkbenchTimeline", () => {
  const items: MessageItem[] = [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", text: "hello there" }],
      sender: { name: null, address: "prn_fixture1@agents.example" },
    },
    {
      id: "m2",
      createdAt: "2026-01-01T00:01:00.000Z",
      parts: [{ kind: "event", event: "member.joined", data: {} }],
      sender: { name: null, address: "prn_fixture1@agents.example" },
    },
    {
      id: "m3",
      createdAt: "2026-01-01T00:02:00.000Z",
      parts: [
        {
          kind: "tool-trace",
          name: "search",
          input: { q: "x" },
          status: "success",
        },
      ],
      sender: { name: null, address: "prn_fixture1@agents.example" },
    },
  ];

  test("renders a text part as a bubble", () => {
    const markup = renderToStaticMarkup(<WorkbenchTimeline items={items} />);
    expect(markup).toContain("hello there");
  });

  // CL-6318: the timeline used to render text, event, file and block and
  // drop `reasoning` and `tool-trace` on the floor — the agent's thinking
  // and every tool call it made were invisible in the product.
  test("renders a tool call as a sentence, with the tool id nowhere in sight", () => {
    const markup = renderToStaticMarkup(<WorkbenchTimeline items={items} />);
    expect(markup).toContain("chat-tool-activity");
    expect(markup).toContain("Searched for &quot;x&quot;");
    expect(markup).toContain('data-status="success"');
  });

  test("renders reasoning as a disclosure rather than dropping it", () => {
    const reasoning: MessageItem[] = [
      {
        id: "m_reason",
        createdAt: "2026-01-01T00:03:00.000Z",
        parts: [{ kind: "reasoning", text: "weighing the options" }],
        sender: { name: null, address: "prn_fixture1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline items={reasoning} />,
    );
    expect(markup).toContain("weighing the options");
    expect(markup).toContain('data-slot="reasoning-part"');
  });

  test("a tool call still running is not shown as finished", () => {
    const running: MessageItem[] = [
      {
        id: "m_running",
        createdAt: "2026-01-01T00:04:00.000Z",
        parts: [
          {
            kind: "tool-trace",
            name: "deploy",
            input: {},
            status: "running",
          },
        ],
        sender: { name: null, address: "prn_fixture1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(<WorkbenchTimeline items={running} />);
    expect(markup).toContain("Deploying");
    expect(markup).toContain('data-status="running"');
    expect(markup).not.toContain('data-status="success"');
  });

  test("shows the sender's name when present", () => {
    const withSender: MessageItem[] = [
      {
        id: "m4",
        createdAt: "2026-01-01T00:03:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline items={withSender} />,
    );
    expect(markup).toContain("Researcher");
  });

  test("renders the tenant-monogram badge when the sender carries shared-workbench tenant context", () => {
    const withSender: MessageItem[] = [
      {
        id: "m4b",
        createdAt: "2026-01-01T00:03:30.000Z",
        parts: [{ kind: "text", text: "hi from the other side" }],
        sender: {
          name: "Researcher",
          address: "researcher@agents.example",
          tenantId: "tnt_2",
          tenantName: "Beta Co",
          tenantMonogram: "BC",
        },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline items={withSender} />,
    );
    expect(markup).toContain("chat-sender-tenant-badge");
    expect(markup).toContain("BC");
  });

  test("shows no tenant-monogram badge when the sender carries no tenant context", () => {
    const withSender: MessageItem[] = [
      {
        id: "m4c",
        createdAt: "2026-01-01T00:03:45.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline items={withSender} />,
    );
    expect(markup).not.toContain("chat-sender-tenant-badge");
  });

  test("falls back to a deterministic 'Member' label with no name and no matching participant", () => {
    const withSender: MessageItem[] = [
      {
        id: "m5",
        createdAt: "2026-01-01T00:04:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "prn_a1b2c3@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline items={withSender} />,
    );
    expect(markup).toContain("Member");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("falls back to 'Member' for any unmatched sender address, agent-shaped or not", () => {
    const withSender: MessageItem[] = [
      {
        id: "m5b",
        createdAt: "2026-01-01T00:04:30.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "ins_unknown1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline items={withSender} />,
    );
    expect(markup).toContain("Member");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("shows a matching participant's friendly handle over the raw local part, badged as an agent", () => {
    const withSender: MessageItem[] = [
      {
        id: "m6",
        createdAt: "2026-01-01T00:05:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "ins_cd03d8e3@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={withSender}
        participants={[
          { address: "ins_cd03d8e3@agents.example", handle: "echo" },
        ]}
      />,
    );
    expect(markup).toContain("@echo");
    expect(markup).toContain("Agent");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("shows a matching participant's display name over its slugified handle", () => {
    const withSender: MessageItem[] = [
      {
        id: "m6b",
        createdAt: "2026-01-01T00:05:30.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: "Myra", address: "ins_myra1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={withSender}
        participants={[{ address: "ins_myra1@agents.example", handle: "myra" }]}
      />,
    );
    expect(markup).toContain(">Myra<");
    expect(markup).not.toContain(">@myra<");
    expect(markup).toContain('title="@myra"');
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("renders the signed-in user's own message as 'You'", () => {
    const withSender: MessageItem[] = [
      {
        id: "m7",
        createdAt: "2026-01-01T00:06:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "prn_self1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={withSender}
        currentUser={{ principalId: "prn_self1" }}
      />,
    );
    expect(markup).toContain("You");
    expect(markup).toContain('data-own="true"');
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  test("renders a footer after the last message", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={items}
        footer={<span className="chat-typing-indicator">typing</span>}
      />,
    );
    const timelineClose = markup.lastIndexOf("</div>");
    expect(markup.slice(0, timelineClose)).toContain("chat-typing-indicator");
  });

  test("renders an event part as a friendly humanized line", () => {
    const markup = renderToStaticMarkup(<WorkbenchTimeline items={items} />);
    expect(markup).toContain("member joined");
    expect(markup).not.toContain("member.joined");
  });

  test("renders a file part with name and media type, never base64 or blob ids", () => {
    const withFile: MessageItem[] = [
      {
        id: "m-file",
        createdAt: "2026-01-01T00:08:00.000Z",
        parts: [
          {
            kind: "file",
            name: "report.pdf",
            mediaType: "application/pdf",
            data: "JVBERi0xLjQK",
          },
        ],
        sender: { name: null, address: "prn_fixture1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(<WorkbenchTimeline items={withFile} />);
    expect(markup).toContain("report.pdf");
    expect(markup).toContain("application/pdf");
    expect(markup).toContain("Attachment");
    expect(markup).not.toContain("JVBERi0xLjQK");
    expect(markup).not.toContain("blob:");
  });

  test("a data-only file part (not yet persisted) renders its artifact chip inert", () => {
    const withFile: MessageItem[] = [
      {
        id: "m-file-inline",
        createdAt: "2026-01-01T00:08:00.000Z",
        parts: [
          {
            kind: "file",
            name: "notes.txt",
            mediaType: "text/plain",
            data: "aGVsbG8=",
          },
        ],
        sender: { name: null, address: "prn_fixture1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline items={withFile} onOpenArtifact={() => {}} />,
    );
    expect(markup).toMatch(
      /<button[^>]*class="chat-artifact-chip-open"[^>]*disabled/,
    );
  });

  test("a blobId-backed file part renders its artifact chip clickable when onOpenArtifact is wired", () => {
    const withFile: MessageItem[] = [
      {
        id: "m-file-blob",
        createdAt: "2026-01-01T00:08:00.000Z",
        parts: [
          {
            kind: "file",
            name: "matrix.csv",
            mediaType: "text/csv",
            blobId: "blob_fixture1_1",
          },
        ],
        sender: { name: null, address: "prn_fixture1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline items={withFile} onOpenArtifact={() => {}} />,
    );
    expect(markup).toContain("matrix.csv");
    expect(markup).not.toMatch(
      /<button[^>]*class="chat-artifact-chip-open"[^>]*disabled/,
    );
  });

  test("a blobId-backed file part stays inert with no onOpenArtifact wired", () => {
    const withFile: MessageItem[] = [
      {
        id: "m-file-blob-unwired",
        createdAt: "2026-01-01T00:08:00.000Z",
        parts: [
          {
            kind: "file",
            name: "matrix.csv",
            mediaType: "text/csv",
            blobId: "blob_fixture1_1",
          },
        ],
        sender: { name: null, address: "prn_fixture1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(<WorkbenchTimeline items={withFile} />);
    expect(markup).toMatch(
      /<button[^>]*class="chat-artifact-chip-open"[^>]*disabled/,
    );
  });

  test("renders the signed-in user's own bubble right-aligned, others left-aligned", () => {
    const bothSenders: MessageItem[] = [
      {
        id: "m-own",
        createdAt: "2026-01-01T00:10:00.000Z",
        parts: [{ kind: "text", text: "mine" }],
        sender: { name: null, address: "prn_self1@agents.example" },
      },
      {
        id: "m-other",
        createdAt: "2026-01-01T00:11:00.000Z",
        parts: [{ kind: "text", text: "theirs" }],
        sender: { name: null, address: "prn_other1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={bothSenders}
        currentUser={{ principalId: "prn_self1" }}
      />,
    );
    expect(markup).toContain('data-own="true"');
    expect(markup).toContain('data-own="false"');
  });

  test("inserts a day divider between items on different calendar days", () => {
    const acrossDays: MessageItem[] = [
      {
        id: "d1",
        createdAt: "2026-01-01T23:59:00.000Z",
        parts: [{ kind: "text", text: "before midnight" }],
        sender: { name: null, address: "prn_fixture1@agents.example" },
      },
      {
        id: "d2",
        createdAt: "2026-01-02T00:01:00.000Z",
        parts: [{ kind: "text", text: "after midnight" }],
        sender: { name: null, address: "prn_fixture1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline items={acrossDays} />,
    );
    expect(markup).toContain("chat-day-divider");
  });

  test("renders an agent-joined event by the joining agent's display name, never its address or bare handle", () => {
    const joinItems: MessageItem[] = [
      {
        id: "m8",
        createdAt: "2026-01-01T00:07:00.000Z",
        parts: [
          {
            kind: "event",
            event: "workbench.agent-joined",
            data: {
              address: "ins_newagent1@agents.example",
              definitionId: "wfd_echo",
              invitedBy: "prn_inviter1",
            },
          },
        ],
        sender: { name: null, address: "prn_fixture1@agents.example" },
      },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={joinItems}
        participants={[
          { address: "ins_newagent1@agents.example", handle: "echo" },
        ]}
      />,
    );
    expect(markup).toContain("Echo joined");
    expect(markup).not.toContain("@echo");
    expect(markup).not.toMatch(RAW_ID_PATTERN);
  });

  // Was asserted against `tool-trace` until CL-6318, which is to say it
  // locked in the defect: a kind the wire really does define was being
  // shown as unsupported. The fallback is for kinds this build genuinely
  // does not know, and it must still never leak the raw payload.
  test("renders an unknown part kind as a labeled fallback block, never the raw payload", () => {
    const unknown = [
      {
        id: "m_unknown",
        createdAt: "2026-01-01T00:05:00.000Z",
        parts: [{ kind: "not-a-real-kind", secret: "hunter2" }],
        sender: { name: null, address: "prn_fixture1@agents.example" },
      },
    ] as unknown as MessageItem[];
    const markup = renderToStaticMarkup(<WorkbenchTimeline items={unknown} />);
    expect(markup).toContain("[not-a-real-kind]");
    expect(markup).toContain("Unsupported content");
    expect(markup).not.toContain("hunter2");
  });

  test("shows the empty timeline state with no messages", () => {
    const markup = renderToStaticMarkup(<WorkbenchTimeline items={[]} />);
    expect(markup).toContain("No messages yet");
  });

  // CL-6092: the quiet "Fix this connection" affordance on a classified
  // inference-failure reply.
  const classifiedFailureItems: MessageItem[] = [
    {
      id: "m_fail",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [
        {
          kind: "text",
          text: "This agent could not complete your request due to a credential error [HTTP 401]: invalid api key",
        },
      ],
      sender: { name: null, address: "prn_fixture1@agents.example" },
    },
  ];

  test("offers Fix this connection on a classified failure reply when a handler is wired", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={classifiedFailureItems}
        onFixConnection={() => {}}
      />,
    );
    expect(markup).toContain("Fix this connection");
  });

  test("never renders HTTP status or the raw provider message on a classified failure reply", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={classifiedFailureItems}
        onFixConnection={() => {}}
      />,
    );
    expect(markup).not.toMatch(/\[HTTP/);
    expect(markup).not.toContain("401");
    expect(markup).not.toContain("invalid api key");
    expect(markup).not.toMatch(/credential error/i);
    expect(markup).toContain(
      "This didn&#x27;t go through. Try again, or check the connection in Settings.",
    );
    expect(markup).toContain("Fix this connection");
  });

  test("renders Fix this connection as a react-ui outline button, not a bare link", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline
        items={classifiedFailureItems}
        onFixConnection={() => {}}
      />,
    );
    const fixConnectionButton = markup.match(
      /<button[^>]*chat-bubble-fix-connection[^>]*>/,
    )?.[0];
    expect(fixConnectionButton).toBeDefined();
    expect(fixConnectionButton).toContain('data-slot="button"');
    expect(fixConnectionButton).toMatch(/\bborder\b/);
  });

  test("offers nothing when no onFixConnection handler is wired, even on a classified reply", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline items={classifiedFailureItems} />,
    );
    expect(markup).not.toContain("Fix this connection");
  });

  test("offers nothing on an ordinary reply, even with a handler wired", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTimeline items={items} onFixConnection={() => {}} />,
    );
    expect(markup).not.toContain("Fix this connection");
  });
});

describe("Composer", () => {
  test("disables send while the draft is empty", () => {
    const markup = renderToStaticMarkup(
      <Composer
        agents={[]}
        onSend={() => Promise.resolve(true)}
        {...composerSlashHandlers}
      />,
    );
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>/);
  });

  test("accepts mention candidates keyed by handle and label", () => {
    const markup = renderToStaticMarkup(
      <Composer
        agents={[
          {
            id: "researcher@agents.example",
            handle: "researcher",
            label: "Researcher",
          },
        ]}
        onSend={() => Promise.resolve(true)}
        {...composerSlashHandlers}
      />,
    );
    expect(markup).not.toContain("@undefined");
  });

  test("exposes an attach control, file input, and polite preparing live region", () => {
    const markup = renderToStaticMarkup(
      <Composer
        agents={[]}
        onSend={() => Promise.resolve(true)}
        {...composerSlashHandlers}
      />,
    );
    expect(markup).toContain('aria-label="Attach files"');
    expect(markup).toContain('type="file"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("chat-composer-status");
    expect(markup).not.toContain("Preparing attachments");
    expect(markup).not.toContain('role="alert"');
  });
});

describe("no raw identifiers on screen", () => {
  test("across the whole workspace's fixture surface — an agent participant, an unknown sender, and a join event", () => {
    const participants = [
      { address: "ins_cd03d8e3@agents.example", handle: "echo" },
      { address: "prn_teammate1@agents.example", handle: "ada" },
    ];
    const messageItems: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hello there" }],
        sender: { name: null, address: "ins_cd03d8e3@agents.example" },
      },
      {
        id: "m2",
        createdAt: "2026-01-01T00:01:00.000Z",
        parts: [{ kind: "text", text: "hi all" }],
        sender: { name: null, address: "prn_unknown1@agents.example" },
      },
      {
        id: "m3",
        createdAt: "2026-01-01T00:02:00.000Z",
        parts: [
          {
            kind: "event",
            event: "workbench.agent-joined",
            data: {
              address: "ins_cd03d8e3@agents.example",
              definitionId: "wfd_echo",
              invitedBy: "prn_inviter1",
            },
          },
        ],
        sender: { name: null, address: "ins_cd03d8e3@agents.example" },
      },
    ];

    const markup = [
      renderToStaticMarkup(
        <WorkbenchTimeline
          items={messageItems}
          participants={participants}
          currentUser={{ principalId: "prn_teammate1" }}
        />,
      ),
      renderToStaticMarkup(
        <Composer
          agents={[
            {
              id: "ins_cd03d8e3@agents.example",
              handle: "echo",
              label: "Echo",
            },
          ]}
          onSend={() => Promise.resolve(true)}
          {...composerSlashHandlers}
        />,
      ),
    ].join("\n");

    expect(markup).not.toMatch(RAW_ID_PATTERN);
    expect(markup).toContain("Echo joined");
  });
});

describe("rowMenuLabels", () => {
  test("offers Unpin for a pinned workbench", () => {
    expect(rowMenuLabels({ pinned: true })).toEqual([
      "Rename",
      "Unpin",
      "Settings",
    ]);
  });

  test("offers Pin for an unpinned workbench", () => {
    expect(rowMenuLabels({ pinned: false })).toEqual([
      "Rename",
      "Pin",
      "Settings",
    ]);
  });
});

describe("renamePayload", () => {
  test("returns the trimmed name when it differs from the current title", () => {
    expect(renamePayload("  New name  ", "Old name")).toBe("New name");
  });

  test("returns undefined for blank input", () => {
    expect(renamePayload("   ", "Old name")).toBeUndefined();
  });

  test("returns undefined when the trimmed input matches the current title", () => {
    expect(renamePayload("Old name", "Old name")).toBeUndefined();
  });
});

describe("profileSubjectFromParticipant", () => {
  test("agent addresses become agent subjects with @ handle display", () => {
    expect(
      profileSubjectFromParticipant({
        address: "scout@agents.example",
        handle: "scout",
      }),
    ).toEqual({
      kind: "agent",
      address: "scout@agents.example",
      handle: "scout",
      displayName: "@scout",
      initials: "SC",
    });
  });

  test("member addresses become member subjects", () => {
    // Human participants are bare principal ids (no @); agent addresses carry a domain.
    const subject = profileSubjectFromParticipant({
      address: "prn_ada",
      handle: "Ada Lovelace",
    });
    expect(subject.kind).toBe("member");
    expect(subject.displayName).toBe("Ada Lovelace");
    expect(subject.initials).toBe("AL");
  });
});

describe("parseTypingEvent", () => {
  test("accepts a well-shaped payload", () => {
    expect(parseTypingEvent({ principalId: "prn_typist1" })).toEqual({
      principalId: "prn_typist1",
    });
  });

  test("rejects a missing principalId", () => {
    expect(parseTypingEvent({})).toBeNull();
  });

  test("rejects a non-object payload", () => {
    expect(parseTypingEvent("prn_typist1")).toBeNull();
    expect(parseTypingEvent(null)).toBeNull();
  });
});

describe("nextTypingState", () => {
  test("a chat.typing event from someone else opens the banner with an expiry", () => {
    const next = nextTypingState(
      null,
      { eventType: "chat.typing", data: { principalId: "prn_other1" } },
      "prn_self1",
      1000,
      4000,
    );
    expect(next).toEqual({ principalId: "prn_other1", expiresAt: 5000 });
  });

  test("a chat.typing event carrying the signed-in user's own id is ignored", () => {
    const next = nextTypingState(
      null,
      { eventType: "chat.typing", data: { principalId: "prn_self1" } },
      "prn_self1",
      1000,
      4000,
    );
    expect(next).toBeNull();
  });

  test("any other event type leaves the current banner untouched", () => {
    const current = { principalId: "prn_other1", expiresAt: 5000 };
    const next = nextTypingState(
      current,
      { eventType: "chat.agent", data: {} },
      "prn_self1",
      1200,
      4000,
    );
    expect(next).toBe(current);
  });

  test("a malformed chat.typing payload leaves the current banner untouched", () => {
    const current = { principalId: "prn_other1", expiresAt: 5000 };
    const next = nextTypingState(
      current,
      { eventType: "chat.typing", data: {} },
      "prn_self1",
      1200,
      4000,
    );
    expect(next).toBe(current);
  });

  test("a second typist replaces the first — the banner always shows the latest ping", () => {
    const afterA = nextTypingState(
      null,
      { eventType: "chat.typing", data: { principalId: "prn_a1" } },
      "prn_self1",
      1000,
      4000,
    );
    const afterB = nextTypingState(
      afterA,
      { eventType: "chat.typing", data: { principalId: "prn_b1" } },
      "prn_self1",
      1500,
      4000,
    );
    expect(afterB).toEqual({ principalId: "prn_b1", expiresAt: 5500 });
  });
});

describe("isTypingStateExpired", () => {
  test("is false before the expiry", () => {
    expect(
      isTypingStateExpired(
        { principalId: "prn_other1", expiresAt: 5000 },
        4000,
      ),
    ).toBe(false);
  });

  test("is true once past the expiry", () => {
    expect(
      isTypingStateExpired(
        { principalId: "prn_other1", expiresAt: 5000 },
        5000,
      ),
    ).toBe(true);
  });

  test("is false with no active state", () => {
    expect(isTypingStateExpired(null, 5000)).toBe(false);
  });
});

describe("typingLabel", () => {
  test("uses the matching participant's handle, never the raw principal id", () => {
    const label = typingLabel("prn_teammate1", [
      { address: "prn_teammate1@agents.example", handle: "ada" },
    ]);
    expect(label).toBe("ada");
    expect(label).not.toMatch(RAW_ID_PATTERN);
  });

  test("falls back to the deterministic Member label with no matching participant", () => {
    expect(typingLabel("prn_unknown1", [])).toBe("Member");
  });

  test("prefers currentUser.name for the signed-in principal (CL-6655)", () => {
    expect(
      typingLabel("prn_self", [], {
        principalId: "prn_self",
        name: "sawyer",
      }),
    ).toBe("sawyer");
  });
});

describe("TypingIndicator", () => {
  test("renders the given label as an 'is typing' status", () => {
    const markup = renderToStaticMarkup(<TypingIndicator label="ada" />);
    expect(markup).toContain("ada is typing");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("chat-typing-row");
    expect(markup).toContain('data-own="false"');
  });
});
