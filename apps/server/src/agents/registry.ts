import type { AgentKind } from "@picone/protocol";
import type { AgentBackend, AgentBackendContext } from "./backend.ts";

/**
 * Which agents exist, and how to start one (§57).
 *
 * The backends are imported lazily and one at a time. Pi and the Claude SDK
 * each pull a large dependency tree, and a workspace that only ever uses one of
 * them should not pay for the other — nor fail to start because the one it does
 * not use is not installed.
 */

export interface AgentInfo {
  kind: AgentKind;
  /** What the picker shows. */
  name: string;
  /** Whether it can actually run here; a reason when it cannot. */
  available: boolean;
  reason?: string;
}

export async function createBackend(kind: AgentKind, context: AgentBackendContext): Promise<AgentBackend> {
  if (kind === "claude") {
    const { ClaudeBackend } = await import("../claude/backend.ts");
    return ClaudeBackend.create(context);
  }
  const { PiBackend } = await import("../pi/backend.ts");
  return PiBackend.create(context);
}

/**
 * What the browser offers when starting a session.
 *
 * An agent that cannot run is listed with the reason rather than hidden: "no
 * Claude executable found" is a thing to go and fix, where a silently missing
 * option is a thing to wonder about.
 */
export async function availableAgents(): Promise<AgentInfo[]> {
  const claude = await import("../claude/available.ts").then(
    (m) => m.claudeAvailability(),
    (error) => ({ available: false, reason: `The Claude SDK is not installed: ${(error as Error).message}` }),
  );
  return [
    { kind: "pi", name: "Pi", available: true },
    { kind: "claude", name: "Claude", available: claude.available, reason: claude.reason },
  ];
}
