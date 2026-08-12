/**
 * One Claude session through the whole server stack, without a browser.
 *
 * Builds a scratch workspace, opens it, starts a Claude session, sends a
 * message, and prints the protocol events the browser would have received —
 * so the translation, the permission gate and the transcript can be checked
 * without clicking anything. Deliberately not a unit test: the point is that a
 * real `claude` runs and real files are touched.
 *
 *   node --import tsx apps/server/scripts/claude-session.mjs [pi|claude]
 *
 * It spends real tokens, and it uses its own data directory under the OS temp
 * dir so it can never touch the development or production store.
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scratch = mkdtempSync(path.join(tmpdir(), "picone-session-"));
process.env.PICONE_DATA_DIR = path.join(scratch, "data");

const agent = process.argv[2] === "pi" ? "pi" : "claude";
const project = path.join(scratch, "project");
const target = path.join(project, "note.md");

const { mkdirSync } = await import("node:fs");
mkdirSync(project, { recursive: true });
writeFileSync(target, "# Notes\n\nnothing yet\n");
const workspaceFile = path.join(project, "scratch.workspace.json");
writeFileSync(
  workspaceFile,
  JSON.stringify({ version: 1, name: "scratch", cwd: project, permissions: { files: "ask", shell: "ask" } }, null, 2),
);

const { App } = await import("../src/app.ts");
const app = new App();

/** Everything the browser would have been sent, in order. */
const seen = [];
app.hub.subscribe = app.hub.subscribe; // keep the shape honest if it changes
const original = app.hub.publish.bind(app.hub);
app.hub.publish = (sessionId, event) => {
  seen.push(event);
  describe(event);
  original(sessionId, event);
};

function describe(event) {
  switch (event.type) {
    case "assistant.delta":
      process.stdout.write(event.text);
      return;
    case "assistant.thinking":
      process.stdout.write(`\x1b[2m${event.text}\x1b[0m`);
      return;
    case "assistant.end":
      process.stdout.write("\n");
      return;
    case "tool.started":
      console.log(`\n  → ${event.toolCall.name}: ${event.toolCall.title}`);
      return;
    case "tool.completed":
      console.log(
        `  ← ${event.toolCall.name} ${event.toolCall.status}: ${(event.toolCall.output ?? "").split("\n")[0]?.slice(0, 90) ?? ""}`,
      );
      return;
    case "permission.requested":
      console.log(`\n  ? ${event.request.title} ${event.request.detail}`);
      return;
    case "notice":
      console.log(`\n  [${event.level}] ${event.text}`);
      return;
    case "context.usage":
      if (event.usage) console.log(`\n  context: ${event.usage.tokens}/${event.usage.contextWindow} (${event.usage.percent}%)`);
      return;
    default:
      return;
  }
}

console.log(`# ${agent} · ${project}`);
await app.openWorkspace(workspaceFile);
const session = await app.createSession("Scratch", agent);
console.log(`session ${session.id} · agent ${session.agent} · caps ${JSON.stringify(session.capabilities)}`);

/**
 * A human at the keyboard: files are fine, the shell is not. Answering
 * differently per category is the point — a gate that only ever says yes has
 * not been tested.
 */
const decisions = [];
app.hub.publish = (sessionId, event) => {
  seen.push(event);
  describe(event);
  if (event.type === "permission.requested") {
    const decision = event.request.category === "files" ? "allow_once" : "deny";
    decisions.push(`${event.request.category}:${decision}`);
    setTimeout(() => app.respondToPermission(event.request.id, decision), 50);
  }
  original(sessionId, event);
};

console.log("\n--- turn 1: a question with no tools -------------------------------");
await app.prompt("In one short sentence, what is in the current directory? Do not use any tools.", "chat", session.id);

console.log("\n--- turn 2: a tool call, through the gate ---------------------------");
await app.prompt(`Append the line "seen by ${agent}" to ${target}. Then say DONE.`, "chat", session.id);
console.log("\nfile now reads:", JSON.stringify(existsSync(target) ? readFileSync(target, "utf8") : "(missing)"));

console.log("\n--- turn 3: something the human refuses ------------------------------");
await app.prompt(`Run the shell command "echo hello" and tell me what it printed.`, "chat", session.id);

console.log("\n--- turn 4: a comment on a file, and the agent closing it ------------");
const comment = await app.addComment({
  path: target,
  matcher: "nothing yet",
  lineStart: 3,
  lineEnd: 3,
  body: "Replace this line with one sentence about what this file is for, then resolve this comment.",
});
console.log("comment:", comment.id.slice(0, 8), "·", comment.status);
// The injection returns before the turn ends, so wait for the queue to clear.
for (let i = 0; i < 60 && app.comments().some((c) => c.status === "open"); i++) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.log("comments now:", app.comments().map((c) => `${c.id.slice(0, 8)}:${c.status}`).join(", "));
console.log("file now reads:", JSON.stringify(readFileSync(target, "utf8")));

console.log("\n--- turn 5: interrupting a long answer -------------------------------");
const long = app.prompt("Count slowly from 1 to 200, one number per line.", "chat", session.id);
await new Promise((resolve) => setTimeout(resolve, 4000));
await app.abort(session.id);
await long;
console.log("aborted; the session is", session.state);

console.log("\n--- turn 6: the session is evicted and reopened ----------------------");
await app.prompt("Remember the number 4242. Reply with just: stored.", "chat", session.id);
const ref = session.resumeRef;
// What eviction does (§38), and what a server restart does the slow way.
// `sessions` is private to the App; reaching in is what a script may do and
// the server may not.
session.dispose();
app["sessions"].delete(session.id);
await app.selectSession(session.id);
const reopened = app.activeSession();
console.log("reopened:", reopened?.id === session.id, "· same resume handle:", reopened?.resumeRef === ref);
await app.prompt("What number did I ask you to remember? Reply with just the number.", "chat", reopened.id);

console.log("\n--- what the browser would have ------------------------------------");
console.log("permission decisions:", decisions.join(", ") || "(nobody was asked)");
const counts = {};
for (const event of seen) counts[event.type] = (counts[event.type] ?? 0) + 1;
console.log(counts);
console.log("model:", JSON.stringify(session.currentModel()));
console.log("commands:", session.commands().length);
console.log("resume ref:", session.resumeRef);
await app.reportStats(session.id);

session.dispose();
process.exit(0);
