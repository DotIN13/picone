/**
 * Start the development server against its own data directory.
 *
 * Not a convenience. Picone's default data directory is `~/.picone`, which is
 * where the *production* service keeps its database and its record of which Pi
 * session belongs to which workspace — so a development server started without
 * `PICONE_DATA_DIR` quietly shares both. Two servers restoring the same
 * workspace open the same Pi session file and append to it independently.
 *
 * This has already gone wrong once: the variable was set at the user level, a
 * shell started before that change never inherited it, and every `npm run dev`
 * from that shell ran against the production store without saying so. An
 * environment variable you have to remember is one that will eventually be
 * forgotten, so the dev script sets it itself and prints where it landed.
 *
 * An explicit `PICONE_DATA_DIR` still wins; this only supplies the default.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const dataDir = process.env.PICONE_DATA_DIR ?? path.join(repo, ".dev-data");

mkdirSync(dataDir, { recursive: true });
console.log(`[picone] dev data directory: ${dataDir}`);

const child = spawn(
  process.execPath,
  [path.join(repo, "node_modules", "tsx", "dist", "cli.mjs"), "watch", "--clear-screen=false", "src/index.ts"],
  { stdio: "inherit", env: { ...process.env, PICONE_DATA_DIR: dataDir } },
);

child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
