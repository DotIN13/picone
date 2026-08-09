import { randomUUID } from "node:crypto";
import type { PermissionCategory, PermissionDecision, PermissionRequest, WorkspacePermissions } from "@picone/protocol";
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
  ) {}

  updatePermissions(permissions: Required<WorkspacePermissions>): void {
    this.permissions = permissions;
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear();
    this.sessionCategoryGrants.clear();
  }

  async check(toolName: string, input: unknown): Promise<GateDecision> {
    const { category, detail, title, cwd } = classifyToolCall(toolName, input);
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
