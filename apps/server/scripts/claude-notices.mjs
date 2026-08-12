/**
 * The notices that used to happen in silence (§58), in a scratch workspace.
 *
 * Only one of the three can be provoked from here: a slash command appearing
 * under a live session. An API retry needs the API to fail and an
 * authentication failure needs a broken login, so those two are written from
 * the message shapes and exercised by the world rather than by this.
 *
 *   node --import tsx apps/server/scripts/claude-notices.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scratch = mkdtempSync(path.join(tmpdir(), "picone-notices-"));
process.env.PICONE_DATA_DIR = path.join(scratch, "data");

const project = path.join(scratch, "project");
mkdirSync(project, { recursive: true });
writeFileSync(
  path.join(project, "scratch.workspace.json"),
  JSON.stringify({ version: 1, name: "scratch", cwd: project, permissions: { files: "allow", shell: "deny" } }, null, 2),
);

const { App } = await import("../src/app.ts");
const app = new App();

const commandFrames = [];
const notices = [];
const publish = app.hub.publish.bind(app.hub);
app.hub.publish = (sessionId, event) => {
  if (event.type === "session.commands") commandFrames.push(event.commands.length);
  if (event.type === "notice") notices.push(`${event.level}: ${event.text.slice(0, 70)}`);
  publish(sessionId, event);
};

await app.openWorkspace(path.join(project, "scratch.workspace.json"));
const session = await app.createSession("Notices", "claude");
await app.prompt("Say ready.", "chat", session.id);
console.log("commands at start:", session.commands().length);

// A command the session did not have when it started.
const commands = path.join(project, ".claude", "commands");
mkdirSync(commands, { recursive: true });
writeFileSync(path.join(commands, "picone-probe.md"), "Say the word probe and nothing else.\n");
console.log("wrote .claude/commands/picone-probe.md");

for (let i = 0; i < 20; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (session.commands().some((c) => c.name.includes("picone-probe"))) break;
}

const found = session.commands().some((c) => c.name.includes("picone-probe"));
console.log("commands now:", session.commands().length, "· probe present:", found);
console.log("session.commands frames pushed:", commandFrames.join(", ") || "(none)");
if (!found) {
  // The stream may only report it after the next turn asks for the list.
  await app.reloadSession(session.id);
  console.log("after /reload · probe present:", session.commands().some((c) => c.name.includes("picone-probe")));
}
console.log("notices:", notices.length ? notices.join("\n  ") : "(none)");

session.dispose();
process.exit(0);
