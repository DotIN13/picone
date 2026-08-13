import type { AgentMode, PermissionSetting, WorkspacePermissions } from "@picone/protocol";

/**
 * What a mode does to the workspace's permissions (§58).
 *
 * A mode is not a message passed through to the agent: Picone is the permission
 * surface, so if a mode is to mean anything it has to mean something *here*.
 * Plan mode proved it — Claude Code's own plan mode refuses edit tools, and a
 * plan-only turn still created a file because our gate had been told files were
 * allowed and duly allowed one.
 *
 * So each mode is a lens over the settings, and two things are outside every
 * lens: an explicit `deny`, which is the user having already decided, and the
 * writable roots, which are checked separately and are the point of the gate.
 * A mode may stop Picone *asking*; it may not widen where an agent can write.
 */
export function permissionsForMode(
  mode: AgentMode,
  permissions: Required<WorkspacePermissions>,
): Required<WorkspacePermissions> {
  const loosen = (setting: PermissionSetting): PermissionSetting => (setting === "ask" ? "allow" : setting);

  switch (mode) {
    /* Editing without being asked each time — files only. A mode called "edit"
       that also stopped asking about shell would be a mode called something
       else. */
    case "edit":
      return { ...permissions, files: loosen(permissions.files) };

    /* Nothing is asked. The agent's own judgement, plus whatever the workspace
       has already refused. */
    case "auto":
      return { files: loosen(permissions.files), shell: loosen(permissions.shell), git: loosen(permissions.git) };

    /* Planning changes nothing, which the session enforces on top of these —
       the settings themselves are left alone so that leaving plan mode does not
       have to remember what they were. */
    case "plan":
    case "manual":
    default:
      return permissions;
  }
}

/** What each mode is called, and what it does, for a human (§58). */
export const MODE_NOTES: Record<AgentMode, string> = {
  manual: "Manual: it asks before anything your workspace settings say to ask about.",
  edit: "Editing freely: file changes inside the workspace no longer ask. Shell and git still do.",
  plan: "Planning: it reads and thinks, and changes nothing, until you take it out of plan mode.",
  auto: "Auto: it stops asking altogether. Anything your settings would have asked about, it just does.",
};
