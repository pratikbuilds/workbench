// The Personal Settings / Shared Settings registry (CL-6089, CL-6116) is the
// single source of truth for both the settings stage and a host's own
// section nav (col2) — these tests pin its ordering, its tenancy gating,
// and which sections are tucked under Advanced, so the two can never
// drift. There is one workbench per account now, so "Workspace" and
// "Personal" collapsed into Shared Settings (who else can see this
// account's one workbench) and Personal Settings — Bench has no section of
// its own anymore, since there is nothing left to name separately from the
// account.

import { describe, expect, test } from "bun:test";
import { Robot } from "@corbits/icons";

import {
  insertEveryoneSections,
  resolveSettingsSectionGroups,
} from "../src/section-registry";
import type { TenancyAccess } from "../src/access";
import type { SettingsSection } from "../src/shell";

const denied: TenancyAccess = {
  people: "denied",
  roles: "denied",
  grants: "denied",
  credentials: "denied",
};

const allowed: TenancyAccess = {
  people: "allowed",
  roles: "allowed",
  grants: "allowed",
  credentials: "allowed",
};

function ids(groups: ReturnType<typeof resolveSettingsSectionGroups>) {
  return groups.map((group) => ({
    id: group.id,
    sections: group.sections.map((section) => section.id),
  }));
}

describe("resolveSettingsSectionGroups", () => {
  test("Account's Account section is always full; gated Everyone sections are absent, not disabled", () => {
    expect(ids(resolveSettingsSectionGroups(denied))).toEqual([
      { id: "account", sections: ["account"] },
      { id: "everyone", sections: ["audit"] },
    ]);
  });

  test("an allowed gate adds its section in registry order", () => {
    expect(ids(resolveSettingsSectionGroups(allowed))).toEqual([
      { id: "account", sections: ["account"] },
      {
        id: "everyone",
        sections: ["connections", "people", "roles", "grants", "audit"],
      },
    ]);
  });

  test("a loading probe withholds its section the same as a denied one", () => {
    const loading: TenancyAccess = {
      people: "loading",
      roles: "denied",
      grants: "allowed",
      credentials: "denied",
    };
    const groups = resolveSettingsSectionGroups(loading);
    expect(ids(groups)).toEqual([
      { id: "account", sections: ["account"] },
      { id: "everyone", sections: ["grants", "audit"] },
    ]);
    expect(
      groups.find((group) => group.id === "everyone")?.accessProbeFailed,
    ).toBe(undefined);
  });

  test("a probe error withholds gated sections but is not an authenticated deny", () => {
    const errored: TenancyAccess = {
      people: "error",
      roles: "error",
      grants: "error",
      credentials: "error",
    };
    const groups = resolveSettingsSectionGroups(errored);
    expect(ids(groups)).toEqual([
      { id: "account", sections: ["account"] },
      { id: "everyone", sections: ["audit"] },
    ]);
    expect(
      groups.find((group) => group.id === "account")?.accessProbeFailed,
    ).toBe(undefined);
    expect(
      groups.find((group) => group.id === "everyone")?.accessProbeFailed,
    ).toBe(true);
    expect(
      resolveSettingsSectionGroups(denied).find(
        (group) => group.id === "everyone",
      )?.accessProbeFailed,
    ).toBe(undefined);
  });

  test("a mixed error withholds only the failed gate and still flags the group", () => {
    const mixed: TenancyAccess = {
      people: "error",
      roles: "allowed",
      grants: "allowed",
      credentials: "allowed",
    };
    const groups = resolveSettingsSectionGroups(mixed);
    expect(ids(groups)).toEqual([
      { id: "account", sections: ["account"] },
      {
        id: "everyone",
        sections: ["connections", "roles", "grants", "audit"],
      },
    ]);
    expect(
      groups.find((group) => group.id === "everyone")?.accessProbeFailed,
    ).toBe(true);
  });

  test("Roles, Grants, and Audit are tucked under Advanced; Connections and People are not", () => {
    const sections = resolveSettingsSectionGroups(allowed).find(
      (group) => group.id === "everyone",
    )?.sections;
    expect(
      sections?.filter((section) => section.advanced === true).map((s) => s.id),
    ).toEqual(["roles", "grants", "audit"]);
    expect(
      sections?.filter((section) => section.advanced !== true).map((s) => s.id),
    ).toEqual(["connections", "people"]);
  });

  test("never registers the personal agent section — no preference store exists to back it yet", () => {
    for (const access of [denied, allowed]) {
      const account = resolveSettingsSectionGroups(access).find(
        (group) => group.id === "account",
      );
      expect(account?.sections.map((section) => section.id)).not.toContain(
        "agent",
      );
    }
  });

  test("never registers the notifications section — no preference store exists to back it yet", () => {
    for (const access of [denied, allowed]) {
      const account = resolveSettingsSectionGroups(access).find(
        (group) => group.id === "account",
      );
      expect(account?.sections.map((section) => section.id)).not.toContain(
        "chat",
      );
    }
  });

  test("every section carries a leading icon for a host's own nav", () => {
    for (const group of resolveSettingsSectionGroups(allowed)) {
      for (const section of group.sections) {
        expect(section.icon).toBeDefined();
      }
    }
  });
});

describe("insertEveryoneSections", () => {
  const extra: readonly SettingsSection[] = [
    { id: "agents", title: "Agents", icon: Robot, render: () => <div /> },
    { id: "skills", title: "Skills", icon: Robot, render: () => <div /> },
  ];

  test("splices host sections into Everyone, at its front", () => {
    const groups = insertEveryoneSections(
      resolveSettingsSectionGroups(denied),
      extra,
    );
    expect(ids(groups)).toEqual([
      { id: "account", sections: ["account"] },
      { id: "everyone", sections: ["agents", "skills", "audit"] },
    ]);
  });

  test("leaves Account untouched", () => {
    const groups = insertEveryoneSections(
      resolveSettingsSectionGroups(allowed),
      extra,
    );
    const account = groups.find((group) => group.id === "account");
    expect(account?.sections.map((section) => section.id)).toEqual(["account"]);
  });

  test("is a no-op when there is nothing to insert", () => {
    const base = resolveSettingsSectionGroups(denied);
    expect(insertEveryoneSections(base, [])).toBe(base);
  });
});
