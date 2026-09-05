import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CorbitAvatar,
  AVATAR_COLORS,
  CORBIT_DEFAULT_COLOR,
  avatarClassForPrincipal,
  avatarColorForPrincipal,
  resolveAvatarFill,
} from "../src";

describe("avatar composition and identity resolution", () => {
  test("agent Corbit avatar is distinct from human initials avatar", () => {
    const corbitHtml = renderToStaticMarkup(
      <CorbitAvatar ariaLabel="Echo Agent" size="md" />,
    );
    expect(corbitHtml).toContain('data-corbit="true"');
    expect(corbitHtml).toContain('aria-label="Echo Agent"');
    expect(corbitHtml).toContain("<svg");
    expect(corbitHtml).toContain(CORBIT_DEFAULT_COLOR);
    expect(corbitHtml).not.toContain(">EA<");
  });

  test("people without photos receive deterministic light pastel initials fallback", () => {
    const aliceColor = avatarColorForPrincipal("usr_alice");
    const bobColor = avatarColorForPrincipal("usr_bob");

    expect(AVATAR_COLORS).toContain(aliceColor);
    expect(AVATAR_COLORS).toContain(bobColor);

    expect(avatarClassForPrincipal("usr_alice")).toContain(aliceColor);

    expect(avatarColorForPrincipal("usr_alice")).toBe(aliceColor);
  });

  test("human explicit image takes precedence over pastel initials fallback", () => {
    const withImage = resolveAvatarFill(
      "usr_alice",
      "https://example.com/avatar.jpg",
    );
    expect(withImage.kind).toBe("image");
    if (withImage.kind === "image") {
      expect(withImage.url).toBe("https://example.com/avatar.jpg");
    }

    const withoutImage = resolveAvatarFill("usr_alice", null);
    expect(withoutImage.kind).toBe("generated");
    if (withoutImage.kind === "generated") {
      expect(withoutImage.className).toBe(avatarClassForPrincipal("usr_alice"));
    }
  });

  test("dense avatar context: multiple agents and humans remain visually distinct", () => {
    const participants = [
      { id: "agent_myra", name: "Myra", isAgent: true },
      { id: "agent_scout", name: "Scout", isAgent: true },
      { id: "user_carla", name: "Carla", isAgent: false },
      { id: "user_dana", name: "Dana", isAgent: false },
    ];

    const rendered = participants.map((p) => {
      if (p.isAgent) {
        return renderToStaticMarkup(
          <CorbitAvatar ariaLabel={p.name} size="sm" />,
        );
      }
      return renderToStaticMarkup(
        <span
          className={avatarClassForPrincipal(p.id)}
          data-testid="human-avatar"
        >
          {p.name.slice(0, 1)}
        </span>,
      );
    });

    expect(rendered[0]).toContain('data-corbit="true"');
    expect(rendered[1]).toContain('data-corbit="true"');
    expect(rendered[2]).toContain('data-testid="human-avatar"');
    expect(rendered[2]).toContain("C");
    expect(rendered[3]).toContain('data-testid="human-avatar"');
    expect(rendered[3]).toContain("D");
  });
});
