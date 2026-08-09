import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Workspace, WorkspaceFile } from "@picone/protocol";
import { DATA_DIR } from "../config.ts";
import { expandInput, suggestWorkspaceName } from "../files/paths.ts";
import { loadWorkspace } from "./loader.ts";

export interface CreateWorkspaceOptions {
  /** The directory the workspace is about. */
  directory: string;
  name?: string;
  /**
   * Exact path to write, for when the user typed a filename rather than picking
   * a folder. Overrides `location`, and its parent becomes the directory.
   */
  file?: string;
  /**
   * `inside` writes the JSON into the directory itself, so it travels with the
   * repository. `central` keeps it in the Picone data directory, for when the
   * project should not carry a Picone file.
   */
  location?: "inside" | "central";
  /** Overwrite an existing file at the target path. */
  overwrite?: boolean;
}

/** Kebab-case, filesystem-safe. */
function slug(name: string): string {
  const value = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return value || "workspace";
}

/**
 * Create a workspace from a directory (DESIGN §3).
 *
 * Starting from a directory is the common case — asking the user to hand-write
 * JSON before they can open anything was the original mistake.
 */
export function createWorkspace(options: CreateWorkspaceOptions): Workspace {
  // A typed filename names its own directory; there is nothing else it could be
  // relative to, and asking the caller to send both invites them to disagree.
  const explicit = options.file ? expandInput(options.file) : null;
  const directory = explicit ? path.dirname(explicit) : expandInput(options.directory);

  if (!existsSync(directory)) throw new Error(`Directory does not exist: ${directory}`);
  if (!statSync(directory).isDirectory()) throw new Error(`Not a directory: ${directory}`);

  const name = options.name?.trim() || suggestWorkspaceName(explicit ?? directory);
  const fileName = `${slug(name)}.workspace.json`;

  let target: string;
  if (explicit) {
    target = explicit;
  } else if (options.location === "central") {
    const dir = path.join(DATA_DIR, "workspaces");
    mkdirSync(dir, { recursive: true });
    target = path.join(dir, fileName);
  } else {
    target = path.join(directory, fileName);
  }

  if (existsSync(target) && !options.overwrite) {
    throw new Error(`A workspace file already exists at ${target}`);
  }

  // A workspace stored inside its own directory refers to it as ".", so the
  // file stays portable when the checkout moves or is cloned elsewhere.
  const directories = options.location === "central" ? [directory] : ["."];

  const file: WorkspaceFile = {
    version: 1,
    name,
    directories,
    permissions: { files: "allow", shell: "ask", git: "ask" },
    voice: { input: true, output: true },
  };

  writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  return loadWorkspace(target);
}
