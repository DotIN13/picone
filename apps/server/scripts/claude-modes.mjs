/**
 * What each mode does to the gate (§58), through the whole stack.
 *
 * The lens has unit tests; this is the part they cannot check — that a mode
 * reaches the live `PermissionGate` and changes what the human is asked. Run
 * against a scratch workspace whose settings ask about everything, so every
 * mode has something to change.
 *
 *   node --import tsx apps/server/scripts/claude-modes.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scratch = mkdtempSync(path.join(tmpdir(), "picone-modes-"));
process.env.PICONE_DATA_DIR = path.join(scratch, "data");

const project = path.join(scratch, "project");
mkdirSync(project, { recursive: true });
writeFileSync(path.join(project, "note.md"), "# Notes\n");
const workspaceFile = path.join(project, "scratch.workspace.json");
writeFileSync(
  workspaceFile,
  JSON.stringify(
    { version: 1, name: "scratch", cwd: project, permissions: { files: "ask", shell: "ask", git: "ask" } },
    null,
    2,
  ),
);

const { App } = await import("../src/app.ts");
const app = new App();

/** Every card raised, and answered yes so the turn can finish. */
let asked = [];
const publish = app.hub.publish.bind(app.hub);
app.hub.publish = (sessionId, event) => {
  if (event.type === "permission.requested") {
    asked.push(event.request.category);
    setTimeout(() => app.respondToPermission(event.request.id, "allow_once"), 30);
  }
  publish(sessionId, event);
};

await app.openWorkspace(workspaceFile);
const session = await app.createSession("Modes", "claude");

const target = path.join(project, "written.txt");
const check = async (mode, prompt, expectation) => {
  await app.setMode(mode, session.id);
  asked = [];
  await app.prompt(prompt, "chat", session.id);
  console.log(`${mode.padEnd(7)} asked about: ${asked.join(", ") || "(nothing)"}  ${expectation}`);
  return asked;
};

console.log(`# permissions all "ask" · ${project}\n`);

const manualWrite = await check(
  "manual",
  `Write the word one to ${target}. Nothing else.`,
  "← expected files",
);
const editWrite = await check(
  "edit",
  `Write the word two to ${target}. Nothing else.`,
  "← expected nothing",
);
const editShell = await check(
  "edit",
  `Use the Bash tool to run exactly: echo hello`,
  "← expected shell",
);
const autoShell = await check(
  "auto",
  `Use the Bash tool to run exactly: echo hello again`,
  "← expected nothing",
);

console.log("\nfile now:", existsSync(target) ? JSON.stringify((await import("node:fs")).readFileSync(target, "utf8")) : "(missing)");
console.log("\nverdict:");
console.log("  manual asks about a write:      ", manualWrite.includes("files"));
console.log("  edit does not:                  ", !editWrite.includes("files"));
console.log("  edit still asks about the shell:", editShell.includes("shell"));
console.log("  auto asks about nothing:        ", autoShell.length === 0);

session.dispose();
process.exit(0);
