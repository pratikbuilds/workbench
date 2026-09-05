// The "Roles" settings section: this bench's roles (system roles marked and
// immutable), create/rename/delete for custom roles, and assigning or
// unassigning a role to a principal — all over the native
// `/api/tenants/:tenantId/roles` and `/principals/:id/roles/:id` routes.

import {
  Badge,
  Button,
  ConfirmButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  SettingsPanel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import { principalLabel } from "./identity";
import { SETTINGS_STRINGS } from "./strings";
import {
  assignRole,
  createRole,
  deleteRole,
  listPrincipals,
  listRoles,
  renameRole,
  unassignRole,
  type Principal,
  type Role,
} from "./tenancy-api";

type RolesData = {
  readonly roles: readonly Role[];
  readonly principals: readonly Principal[];
};

export function RolesSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [query, setQuery] = useState<APIQuery<RolesData>>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  function reload() {
    setReloadKey((value) => value + 1);
  }

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setQuery({ kind: "loading" });
    Promise.all([listRoles(tenantId), listPrincipals(tenantId)])
      .then(([roles, principals]) => {
        if (!cancelled)
          setQuery({ kind: "ready", data: { roles, principals } });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof UnauthenticatedError) {
          setQuery({ kind: "unauthenticated" });
          return;
        }
        setQuery({
          kind: "error",
          message: describeQueryError(cause),
          retry: reload,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, reloadKey]);

  if (tenantId === null) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.benchNoneSelectedTitle}
        description={SETTINGS_STRINGS.benchNoneSelectedDescription}
      />
    );
  }

  function handleCreate(name: string, description: string) {
    if (tenantId === null) return;
    setCreating(true);
    setCreateError(null);
    createRole(
      tenantId,
      description.length > 0 ? { name, description } : { name },
    )
      .then(() => {
        setCreateOpen(false);
        reload();
      })
      .catch(() => setCreateError(SETTINGS_STRINGS.rolesCreateError))
      .finally(() => setCreating(false));
  }

  function handleDelete(role: Role) {
    if (tenantId === null) return;
    setRowError(null);
    deleteRole(tenantId, role.id)
      .then(reload)
      .catch(() => setRowError(SETTINGS_STRINGS.rolesDeleteError));
  }

  function handleRename(role: Role, name: string) {
    if (tenantId === null) return;
    setRowError(null);
    renameRole(tenantId, role.id, { name })
      .then(reload)
      .catch(() => setRowError(SETTINGS_STRINGS.rolesRenameError));
  }

  function handleAssign(principalId: string, roleId: string) {
    if (tenantId === null) return;
    setRowError(null);
    assignRole(tenantId, principalId, roleId)
      .then(reload)
      .catch(() => setRowError(SETTINGS_STRINGS.rolesAssignError));
  }

  function handleUnassign(principalId: string, roleId: string) {
    if (tenantId === null) return;
    setRowError(null);
    unassignRole(tenantId, principalId, roleId)
      .then(reload)
      .catch(() => setRowError(SETTINGS_STRINGS.rolesUnassignError));
  }

  return (
    <QueryView query={query} label={SETTINGS_STRINGS.rolesLoadError}>
      {({ roles, principals }) => (
        <SettingsPanel
          title={SETTINGS_STRINGS.rolesSectionTitle}
          description={SETTINGS_STRINGS.rolesSectionDescription}
        >
          <div className="settings-section-toolbar">
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              {SETTINGS_STRINGS.rolesCreateAction}
            </Button>
          </div>
          {rowError !== null && (
            <p className="settings-inline-error" role="alert">
              {rowError}
            </p>
          )}
          <RolesTable
            roles={roles}
            onDelete={handleDelete}
            onRename={handleRename}
          />
          <RoleAssignments
            roles={roles}
            principals={principals}
            onAssign={handleAssign}
            onUnassign={handleUnassign}
          />
          <CreateRoleDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            onCreate={handleCreate}
            submitting={creating}
            error={createError}
          />
        </SettingsPanel>
      )}
    </QueryView>
  );
}

export function RolesTable({
  roles,
  onDelete,
  onRename,
}: {
  readonly roles: readonly Role[];
  readonly onDelete: (role: Role) => void;
  readonly onRename: (role: Role, name: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  if (roles.length === 0) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.rolesEmptyTitle}
        description={SETTINGS_STRINGS.rolesEmptyDescription}
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="settings-actions-cell">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {roles.map((role) => (
          <TableRow key={role.id}>
            <TableCell>
              {editingId === role.id ? (
                <Input
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  autoFocus
                />
              ) : (
                <>
                  {role.name}{" "}
                  {role.isSystem && (
                    <Badge tone="neutral">
                      {SETTINGS_STRINGS.rolesSystemBadge}
                    </Badge>
                  )}
                </>
              )}
            </TableCell>
            <TableCell>{role.description ?? ""}</TableCell>
            <TableCell className="settings-actions-cell">
              {role.isSystem ? (
                <span className="settings-field-hint">
                  {SETTINGS_STRINGS.rolesSystemImmutableNote}
                </span>
              ) : editingId === role.id ? (
                <div className="settings-row-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={draftName.trim().length === 0}
                    onClick={() => {
                      onRename(role, draftName.trim());
                      setEditingId(null);
                    }}
                  >
                    {SETTINGS_STRINGS.rolesRenameSave}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditingId(null)}
                  >
                    {SETTINGS_STRINGS.rolesRenameCancel}
                  </Button>
                </div>
              ) : (
                <div className="settings-row-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingId(role.id);
                      setDraftName(role.name);
                    }}
                  >
                    {SETTINGS_STRINGS.rolesRenameAction}
                  </Button>
                  <ConfirmButton
                    variant="destructive"
                    size="sm"
                    confirmLabel={SETTINGS_STRINGS.rolesDeleteConfirm}
                    onConfirm={() => onDelete(role)}
                  >
                    {SETTINGS_STRINGS.rolesDeleteAction}
                  </ConfirmButton>
                </div>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RoleAssignments({
  roles,
  principals,
  onAssign,
  onUnassign,
}: {
  readonly roles: readonly Role[];
  readonly principals: readonly Principal[];
  readonly onAssign: (principalId: string, roleId: string) => void;
  readonly onUnassign: (principalId: string, roleId: string) => void;
}) {
  const [principalId, setPrincipalId] = useState("");
  const [roleId, setRoleId] = useState("");

  // CL-6664: Scope both picker and assignments to user-kind principals only.
  // Agents and workflows are machine identities — the "Person" picker and
  // its assignment table should match the People section's member roster,
  // not the full tenant-wide principal list.
  const people = principals.filter((p) => p.kind === "user");

  const assignments = people.flatMap((principal) =>
    principal.roles.map((role) => ({ principal, role })),
  );

  return (
    <div className="settings-form-field">
      <h4>{SETTINGS_STRINGS.rolesAssignSectionTitle}</h4>
      <div className="settings-row-actions">
        <label className="settings-form-field">
          <span>{SETTINGS_STRINGS.rolesAssignPersonLabel}</span>
          <select
            className="settings-select"
            value={principalId}
            onChange={(event) => setPrincipalId(event.target.value)}
          >
            <option value="">—</option>
            {people.map((principal) => (
              <option key={principal.id} value={principal.id}>
                {principalLabel(principal.displayName).label}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-form-field">
          <span>{SETTINGS_STRINGS.rolesAssignRoleLabel}</span>
          <select
            className="settings-select"
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
          >
            <option value="">—</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          disabled={principalId.length === 0 || roleId.length === 0}
          onClick={() => onAssign(principalId, roleId)}
        >
          {SETTINGS_STRINGS.rolesAssignSubmit}
        </Button>
      </div>
      <h4>{SETTINGS_STRINGS.rolesAssignmentsTitle}</h4>
      {assignments.length === 0 ? (
        <p className="settings-field-hint">
          {SETTINGS_STRINGS.rolesAssignmentsEmpty}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {assignments.map(({ principal, role }) => (
              <TableRow key={`${principal.id}-${role.id}`}>
                <TableCell>
                  {principalLabel(principal.displayName).label}
                </TableCell>
                <TableCell>{role.name}</TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onUnassign(principal.id, role.id)}
                  >
                    {SETTINGS_STRINGS.rolesUnassign}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function CreateRoleDialog({
  open,
  onOpenChange,
  onCreate,
  submitting,
  error = null,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (name: string, description: string) => void;
  readonly submitting: boolean;
  readonly error?: string | null;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const canSubmit = name.trim().length > 0;

  function reset() {
    setName("");
    setDescription("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{SETTINGS_STRINGS.rolesCreateDialogTitle}</DialogTitle>
          <DialogDescription>
            {SETTINGS_STRINGS.rolesCreateDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="create-role-form"
            className="settings-form-field"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) onCreate(name.trim(), description.trim());
            }}
          >
            <label className="settings-form-field">
              <span>{SETTINGS_STRINGS.rolesNameLabel}</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={SETTINGS_STRINGS.rolesNamePlaceholder}
                autoFocus
              />
            </label>
            <label className="settings-form-field">
              <span>{SETTINGS_STRINGS.rolesDescriptionLabel}</span>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            {error !== null && (
              <p className="settings-inline-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {SETTINGS_STRINGS.rolesCreateCancel}
          </Button>
          <Button
            type="submit"
            form="create-role-form"
            variant="primary"
            disabled={!canSubmit || submitting}
          >
            {SETTINGS_STRINGS.rolesCreateSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
