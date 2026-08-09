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
  /** Resolves relative tool arguments the way the session's own tools would. */
  cwd: string;
  /**
   * Where writing is permitted: the workspace roots, plus any memory directory
   * marked writable. Read live, since a workspace edit can change it.
   */
  writableRoots(): string[];
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
   * The first path this call would write that lies outside every writable
   * root, or null when they all lie inside. One forbidden target is enough to
   * refuse the whole call: a `multiedit` is not half-applied.
   */
  private firstForbiddenWrite(writes: string[]): string | null {
    if (writes.length === 0) return null;
    const roots = this.paths.writableRoots();

    for (const target of writes) {
      const abs = path.resolve(this.paths.cwd, target);
      if (!roots.some((root) => isInside(root, abs))) return abs;
    }
    return null;
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear();
    this.sessionCategoryGrants.clear();
  }

  async check(toolName: string, input: unknown): Promise<GateDecision> {
    const { category, detail, title, cwd, writes } = classifyToolCall(toolName, input);

    // Location before category. `files: allow` means "writes inside the
    // workspace", which is what anyone reading that setting assumes it means —
    // it was never meant to hand over the rest of the disk.
    const forbidden = this.firstForbiddenWrite(writes);
    if (forbidden) {
      const roots = this.paths.writableRoots();
      return {
        allowed: false,
        reason:
          `Blocked: ${forbidden} is outside this workspace, and writing outside it is never permitted.\n` +
          `Writable locations:\n${roots.map((root) => `- ${root}`).join("\n")}\n` +
          `Work within those, or ask the user to add the directory to the workspace.`,
      };
    }

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
