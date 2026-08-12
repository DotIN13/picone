import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PermissionCategory, PermissionDecision, PermissionRequest, WorkspacePermissions } from "@picone/protocol";
import { isInside } from "../util/paths.ts";
import { classifyToolCall, grantKey } from "./policy.ts";

export interface GateDecision {
  allowed: boolean;
  reason?: string;
  request?: PermissionRequest;
  decision?: PermissionDecision;
}

export interface GateHooks {
  /** Push the card to the UI and resolve when the human answers. */
  ask(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface GatePaths {
  /** What to call the agent on a permission card (§58). */
  agent?: string;
  /** Resolves relative tool arguments the way the session's own tools would. */
  cwd: string;
  /**
   * Every root, not only the writable ones — a refusal reads very differently
   * when the target is a read-only memory directory the agent is *meant* to be
   * using than when it is somewhere off the map entirely. Read live, since a
   * workspace edit can change both the list and the flags.
   */
  roots(): Array<{ path: string; writable: boolean; kind: "cwd" | "context" | "memory" }>;
}

/**
 * The permission gate for one session (DESIGN §9/§10).
 *
 * The workspace JSON holds the persistent policy; "allow for session" grants
 * live only here and die with the session.
 */
export class PermissionGate {
  private readonly sessionGrants = new Set<string>();
  private readonly sessionCategoryGrants = new Set<PermissionCategory>();

  constructor(
    private permissions: Required<WorkspacePermissions>,
    private readonly hooks: GateHooks,
    private readonly paths: GatePaths,
  ) {}

  updatePermissions(permissions: Required<WorkspacePermissions>): void {
    this.permissions = permissions;
  }

  /**
   * The first path this call would write that it may not, with enough context
   * to explain the refusal. One forbidden target is enough to refuse the whole
   * call: a `multiedit` is not half-applied.
   */
  private firstForbiddenWrite(writes: string[]): { target: string; reason: string } | null {
    if (writes.length === 0) return null;
    const roots = this.paths.roots();
    const writable = roots.filter((root) => root.writable);

    for (const target of writes) {
      const abs = path.resolve(this.paths.cwd, target);
      if (writable.some((root) => isInside(root.path, abs))) continue;

      const readOnly = roots.find((root) => !root.writable && isInside(root.path, abs));
      const where = `Writable locations:\n${writable.map((root) => `- ${root.path}`).join("\n")}`;

      return {
        target: abs,
        reason: readOnly
          ? `Blocked: ${abs} is in "${readOnly.path}", which is read-only. ` +
            `Read it freely, but say what you would change rather than changing it.\n${where}`
          : `Blocked: ${abs} is outside this workspace, and writing outside it is never permitted.\n` +
            `${where}\nWork within those, or ask the user to add the directory to the workspace.`,
      };
    }
    return null;
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear();
    this.sessionCategoryGrants.clear();
  }

  async check(toolName: string, input: unknown): Promise<GateDecision> {
    const { category, detail, title, cwd, writes } = classifyToolCall(toolName, input, this.paths.agent);

    // Location before category. `files: allow` means "writes inside the
    // workspace", which is what anyone reading that setting assumes it means —
    // it was never meant to hand over the rest of the disk.
    const forbidden = this.firstForbiddenWrite(writes);
    if (forbidden) return { allowed: false, reason: forbidden.reason };

    if (category === null) return { allowed: true };

    const setting = this.permissions[category];
    if (setting === "allow") return { allowed: true };
    if (setting === "deny") {
      return {
        allowed: false,
        reason: `Blocked: workspace permission "${category}" is set to "deny".`,
      };
    }

    // setting === "ask"
    if (this.sessionCategoryGrants.has(category)) return { allowed: true };
    const key = grantKey(category, detail);
    if (this.sessionGrants.has(key)) return { allowed: true };

    const request: PermissionRequest = {
      id: randomUUID(),
      category,
      toolName,
      title,
      detail,
      cwd,
      createdAt: new Date().toISOString(),
    };

    const decision = await this.hooks.ask(request);

    if (decision === "allow_session") {
      // Repeated identical calls and the broader category both stop asking:
      // the human said yes to this kind of work for the rest of the session.
      this.sessionGrants.add(key);
      this.sessionCategoryGrants.add(category);
    }

    if (decision === "deny") {
      return {
        allowed: false,
        reason: "The user denied this action. Do not retry it; ask what they would prefer.",
        request,
        decision,
      };
    }

    return { allowed: true, request, decision };
  }
}
