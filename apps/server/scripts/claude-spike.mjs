/**
 * Answers the three questions the Claude plan could not answer from the types
 * (docs/todo/claude-agent.md, phase 0). Wired to nothing; run it by hand:
 *
 *   node apps/server/scripts/claude-spike.mjs gate      does the hook alone gate a write?
 *   node apps/server/scripts/claude-spike.mjs slow      does a hook survive a slow human?
 *   node apps/server/scripts/claude-spike.mjs resume    does sessionId + resume round-trip?
 *   node apps/server/scripts/claude-spike.mjs exe       where did it find the CLI?
 *
 * It spends real tokens on the machine's own Claude login. Each case is one
 * short turn against a scratch directory under the OS temp dir.
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Where the CLI is, with the 283 MB platform package deliberately uninstalled.
 * An override, then whatever is on PATH; `undefined` leaves the SDK to look for
 * its own bundled binary, which is the case this exists to check.
 */
function claudeExecutable() {
  const override = process.env.PICONE_CLAUDE_PATH;
  if (override && existsSync(override)) return override;
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const scratch = mkdtempSync(path.join(tmpdir(), "picone-spike-"));
const log = (...parts) => console.log(...parts);

/** One turn, streaming input, with whatever options the case wants. */
async function turn(text, options, onMessage) {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  async function* input() {
    yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: text } };
    await gate;
  }

  const q = query({
    prompt: input(),
    options: {
      cwd: scratch,
      settingSources: [],
      pathToClaudeCodeExecutable: claudeExecutable(),
      ...options,
    },
  });
  let result;
  for await (const message of q) {
    onMessage?.(message, q);
    if (message.type === "result") {
      result = message;
      release();
      q.close();
      break;
    }
  }
  return result;
}

/** The gate as the backend will use it: a PreToolUse hook, and nothing else. */
function gateHook(decide) {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            const verdict = await decide(input);
            if (verdict.allowed) return {};
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: verdict.reason,
              },
            };
          },
        ],
      },
    ],
  };
}

const cases = {
  /**
   * Q1. A write is what the CLI would normally prompt for. With no TTY and no
   * canUseTool, does an allowing hook get it through — or does the CLI's own
   * prompt path deny it anyway?
   */
  async gate() {
    const target = path.join(scratch, "written-by-claude.txt");
    const asked = [];
    await turn(
      `Write the text "picone" to the file ${target}, then stop.`,
      { maxTurns: 4, hooks: gateHook(async ({ tool_name }) => (asked.push(tool_name), { allowed: true })) },
      (message) => {
        if (message.type === "system" && message.subtype === "permission_denied") {
          log("  permission_denied frame:", message.tool_name);
        }
      },
    );
    log("tools the hook saw:", asked.join(", ") || "(none)");
    log("file written:", existsSync(target));
    log(
      existsSync(target)
        ? "A1. The hook alone is enough: allow it and the write happens."
        : "A1. The hook is not enough — the CLI's own layer refused. canUseTool or bypassPermissions needed.",
    );
  },

  /**
   * Q1b. Given that the hook can refuse but not grant, does adding a
   * `canUseTool` that says yes complete the picture — hook for the calls the
   * CLI would wave through, callback for the ones it would prompt about?
   */
  async both() {
    const target = path.join(scratch, "written-by-claude.txt");
    const hookSaw = [];
    const callbackSaw = [];
    await turn(
      `Write the text "picone" to the file ${target}, then stop.`,
      {
        maxTurns: 4,
        hooks: gateHook(async ({ tool_name }) => (hookSaw.push(tool_name), { allowed: true })),
        canUseTool: async (toolName, input) => {
          callbackSaw.push(toolName);
          return { behavior: "allow", updatedInput: input };
        },
      },
      (message) => {
        if (message.type === "system" && message.subtype === "permission_denied") log("  denied frame:", message.tool_name);
        if (message.type === "user" && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type === "tool_result" && block.is_error) log("  tool error:", JSON.stringify(block.content).slice(0, 160));
          }
        }
      },
    );
    log("hook saw:    ", hookSaw.join(", ") || "(none)");
    log("callback saw:", callbackSaw.join(", ") || "(none)");
    log("file written:", existsSync(target));
    log(
      existsSync(target)
        ? "A1b. Hook + canUseTool is the gate: the hook sees everything, the callback grants what the CLI would ask about."
        : "A1b. Still refused. The only remaining option is bypassPermissions, with our hook as the sole gate.",
    );
  },

  /**
   * Q1c. The other shape: Picone's gate is the only gate, and the CLI's layer
   * is told to stand aside entirely.
   */
  async bypass() {
    const target = path.join(scratch, "written-by-claude.txt");
    const hookSaw = [];
    await turn(
      `Write the text "picone" to the file ${target}, then stop.`,
      {
        maxTurns: 4,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        hooks: gateHook(async ({ tool_name }) => {
          hookSaw.push(tool_name);
          // Refuse the shell, allow the write: does the hook still bite when
          // the CLI's own layer has been told to stand aside?
          return tool_name === "Write" ? { allowed: true } : { allowed: false, reason: "Picone: shell is denied here." };
        }),
      },
    );
    log("hook saw:", hookSaw.join(", ") || "(none)");
    log("file written:", existsSync(target));
    log(
      existsSync(target)
        ? "A1c. bypassPermissions + hook works, and the hook still refuses what it wants to refuse."
        : "A1c. Even bypassPermissions did not get the write through.",
    );
  },

  /** Q2. A human takes their time. Does the hook's promise survive 45 seconds? */
  async slow() {
    writeFileSync(path.join(scratch, "package.json"), '{"name":"spike"}');
    const started = Date.now();
    let held = 0;
    const result = await turn(
      `Read the file ${path.join(scratch, "package.json")}, then say DONE.`,
      {
        maxTurns: 3,
        hooks: gateHook(async () => {
          const t = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 45_000));
          held = Date.now() - t;
          return { allowed: true };
        }),
      },
    );
    log(`held the hook for ${Math.round(held / 1000)}s; turn took ${Math.round((Date.now() - started) / 1000)}s`);
    log("result:", result?.subtype, JSON.stringify(result?.result ?? "").slice(0, 120));
    log(
      result?.subtype === "success"
        ? "A2. A slow decision is fine — the hook is awaited, not raced."
        : "A2. Something timed out. The gate needs its own deadline and a default.",
    );
  },

  /**
   * Q3. Picone's session ids are UUIDs already. Can one be *given* to the SDK
   * and resumed in a later process, so there is no id mapping to keep?
   */
  async resume() {
    const id = randomUUID();
    log("session id:", id);
    const first = await turn(`Remember the number 61758. Reply with just: stored.`, {
      sessionId: id,
      maxTurns: 1,
      hooks: gateHook(async () => ({ allowed: false, reason: "No tools needed for this." })),
    });
    log("first turn:", first?.subtype, JSON.stringify(first?.result ?? "").slice(0, 80));

    const second = await turn(`What number did I ask you to remember? Reply with just the number.`, {
      resume: id,
      maxTurns: 1,
      hooks: gateHook(async () => ({ allowed: false, reason: "No tools needed for this." })),
    });
    const answer = String(second?.result ?? "");
    log("after resume:", second?.subtype, JSON.stringify(answer).slice(0, 80));
    log(
      answer.includes("61758")
        ? "A3. Our own UUID is the session id, and resume brings the conversation back."
        : "A3. Resume did not carry the conversation — the id needs checking.",
    );
  },

  /**
   * Q5. Picone records the session id as soon as the session exists, so a
   * session that was closed before it ever said anything will be resumed by an
   * id the CLI has never written. Does that fail, and how loudly?
   */
  async ghost() {
    const id = randomUUID();
    log("resuming a session that was never written:", id);
    try {
      const result = await turn("Say OK.", { resume: id, maxTurns: 1 });
      log("result:", result?.subtype, JSON.stringify(result?.result ?? "").slice(0, 120));
      log("A5. Resuming an unknown id is survivable — it starts a conversation rather than failing.");
    } catch (error) {
      log("threw:", String(error).slice(0, 200));
      log("A5. Resuming an unknown id throws, so the backend needs to fall back to a fresh session.");
    }
  },

  /** Where the CLI came from, with the 283 MB platform package left uninstalled. */
  async exe() {
    writeFileSync(path.join(scratch, "package.json"), "{}\n");
    log("resolved executable:", claudeExecutable() ?? "(none — leaving it to the SDK's bundled binary)");
    const init = await new Promise(async (resolve) => {
      await turn("Say OK.", { maxTurns: 1 }, (message) => {
        if (message.type === "system" && message.subtype === "init") resolve(message);
      });
      resolve(null);
    });
    log("claude_code_version:", init?.claude_code_version);
    log("cwd it ran in:", init?.cwd);
    log("model:", init?.model, "· auth:", init?.apiKeySource);
    log("A4. It resolved a CLI without the bundled binary being installed.");
  },
};

const name = process.argv[2];
const chosen = cases[name];
if (!chosen) {
  console.error(`usage: claude-spike.mjs <${Object.keys(cases).join("|")}>`);
  process.exit(2);
}
log(`# ${name} · scratch ${scratch}`);
await chosen();
