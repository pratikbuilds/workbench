// CL-6664: the "Assign a role" person picker must show only user-kind
// principals — the same roster as the People section. Agent/workflow
// machine identities are excluded to prevent placeholder-named garbage
// accounts from polluting the picker.
//
// CL-7378: the Roles table's Actions cells must not inherit page-fill's
// nowrap+ellipsis clip, or system-role notes and Rename/Delete controls
// get truncated.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { RoleAssignments, RolesTable } from "../src/roles-section";

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function principal(
  kind: "user" | "agent" | "workflow",
  id: string,
  name: string,
) {
  return {
    id,
    tenantId: "tnt_1",
    kind,
    refId: `${kind}_${id}`,
    displayName: name,
    status: "active" as const,
    roles: [],
    ...timestamps,
  };
}

function actionsCellOpenTag(markup: string): string {
  const heads = [...markup.matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/g)];
  const index = heads.findIndex((match) => /Actions/.test(match[0]));
  if (index === -1) throw new Error("no Actions column");
  const firstRow = /<tbody[\s\S]*?<tr[\s\S]*?<\/tr>/.exec(markup);
  if (firstRow === null) throw new Error("no body row");
  const cells = [...firstRow[0].matchAll(/<td\b[^>]*>/g)];
  const cell = cells[index];
  if (cell === undefined) throw new Error("no Actions td");
  return cell[0];
}

function ruleFor(css: string, className: string): string {
  const selector = new RegExp(`\\.${className}\\s*[,{]`);
  const block = css.split("}").find((candidate) => selector.test(candidate));
  if (block === undefined) throw new Error(`no rule for .${className}`);
  return block.slice(block.indexOf("{"));
}

describe("RoleAssignments picker", () => {
  test("shows only user-kind principals, not agents or workflows", () => {
    const markup = renderToStaticMarkup(
      <RoleAssignments
        roles={[
          {
            id: "role_1",
            tenantId: "tnt_1",
            name: "Billing",
            isSystem: false,
            ...timestamps,
          },
        ]}
        principals={[
          principal("user", "prn_user", "Alice Anderson"),
          principal("agent", "prn_agent", "Research Assistant"),
          principal("workflow", "prn_wf", "Nightly digest"),
        ]}
        onAssign={() => undefined}
        onUnassign={() => undefined}
      />,
    );

    expect(markup).toContain("Alice Anderson");
    expect(markup).not.toContain("Research Assistant");
    expect(markup).not.toContain("Nightly digest");
    expect(markup).not.toContain("<optgroup");
  });

  test("shows no optgroups (flat list)", () => {
    const markup = renderToStaticMarkup(
      <RoleAssignments
        roles={[]}
        principals={[
          principal("user", "prn_1", "Alice Anderson"),
          principal("user", "prn_2", "Bob Baker"),
        ]}
        onAssign={() => undefined}
        onUnassign={() => undefined}
      />,
    );
    expect(markup).not.toContain("<optgroup");
    expect(markup).toContain("Alice Anderson");
    expect(markup).toContain("Bob Baker");
  });

  test("excludes agents from the assignments table too", () => {
    const markup = renderToStaticMarkup(
      <RoleAssignments
        roles={[]}
        principals={[
          principal("user", "prn_user", "Alice Anderson"),
          principal("agent", "prn_agent", "Research Assistant"),
        ]}
        onAssign={() => undefined}
        onUnassign={() => undefined}
      />,
    );
    // The assignments table header should exist but have no rows
    expect(markup).toContain("No one has been assigned a role yet.");
    expect(markup).not.toContain("Research Assistant");
  });

  test("does not show user kind label for single-kind list", () => {
    const markup = renderToStaticMarkup(
      <RoleAssignments
        roles={[]}
        principals={[principal("user", "prn_1", "Alice Anderson")]}
        onAssign={() => undefined}
        onUnassign={() => undefined}
      />,
    );
    expect(markup).toContain("Alice Anderson");
    expect(markup).not.toContain("<optgroup");
  });
});

describe("RolesTable Actions column", () => {
  test("Actions cells opt out of page-fill nowrap-ellipsis clipping", () => {
    const markup = renderToStaticMarkup(
      <RolesTable
        roles={[
          {
            id: "role_owner",
            tenantId: "tnt_1",
            name: "owner",
            isSystem: true,
            ...timestamps,
          },
          {
            id: "role_billing",
            tenantId: "tnt_1",
            name: "Billing",
            isSystem: false,
            ...timestamps,
          },
        ]}
        onDelete={() => undefined}
        onRename={() => undefined}
      />,
    );

    expect(actionsCellOpenTag(markup)).toContain("settings-actions-cell");

    const css = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8",
    );
    const cell = ruleFor(css, "settings-actions-cell");
    expect(cell).toContain("overflow: visible");
    expect(cell).toContain("min-width");
    expect(cell).not.toContain("text-overflow: ellipsis");
    expect(cell).not.toContain("white-space: nowrap");
    expect(cell).not.toContain("overflow: hidden");

    const actions = ruleFor(css, "settings-row-actions");
    expect(actions).toContain("min-width");
  });
});
