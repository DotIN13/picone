import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ResolvedMemoryDir } from "@picone/protocol";
import { MEMORY_INDEX_FILE, MEMORY_INSTRUCTIONS_FILE } from "./registry.ts";

/**
 * What the agent is told about memory (DESIGN §50).
 *
 * A memory store worth having already documents itself, so Picone does not
 * describe one — it hands over the directory's own `AGENTS.md`. A directory
 * without one gets a listing instead, which is enough to know the shape.
 */

/** Instructions are worth their context; a store that rambles gets truncated. */
const MAX_INSTRUCTIONS = 32_000;

/** Enough of a listing to know the shape, not so much that it competes with `index.md`. */
const MAX_LISTED_ENTRIES = 40;

export function memoryContextFiles(dirs: ResolvedMemoryDir[]): Array<{ path: string; content: string }> {
  const live = dirs.filter((dir) => dir.enabled && dir.exists);
  if (live.length === 0) return [];

  const files: Array<{ path: string; content: string }> = [
    { path: "Memory directories (Picone)", content: header(live) },
  ];

  for (const dir of live) {
    files.push({
      path: `${dir.path} (memory)`,
      content: dir.hasInstructions ? instructions(dir) : listing(dir),
    });
  }
  return files;
}

function header(dirs: ResolvedMemoryDir[]): string {
  const lines: string[] = [];
  lines.push(
    dirs.length === 1
      ? "One directory of long-lived notes about the user is available to you."
      : `${dirs.length} directories of long-lived notes about the user are available to you.`,
  );
  lines.push("");
  lines.push(
    "Read them before answering anything about the user, their work, their schedule, " +
      "or the people around them. They are not project code: nothing in them is a source " +
      "file, and they are not where a coding task belongs.",
  );
  lines.push("");

  for (const dir of dirs) {
    const notes = [dir.writable ? "writable" : "read-only"];
    if (dir.hasIndex) notes.push(`catalog: ${MEMORY_INDEX_FILE}`);
    lines.push(`- **${dir.name}** — \`${dir.path}\` (${notes.join(", ")})`);
  }

  const readOnly = dirs.filter((dir) => !dir.writable);
  if (readOnly.length > 0) {
    lines.push("");
    lines.push(
      `Writing is refused in ${readOnly.map((dir) => `\`${dir.name}\``).join(", ")}. ` +
        "Do not offer to edit anything there; say what you would change and leave it to the user.",
    );
  }

  const withIndex = dirs.filter((dir) => dir.hasIndex);
  if (withIndex.length > 0) {
    lines.push("");
    lines.push(
      `Each catalog lists the pages in its store with a one-line summary. Read the catalog first ` +
        "and then only the pages you need — these stores are far too large to read whole.",
    );
  }

  return lines.join("\n");
}

/** The directory's own instructions, verbatim. It knows itself better than we do. */
function instructions(dir: ResolvedMemoryDir): string {
  const file = path.join(dir.path, MEMORY_INSTRUCTIONS_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return `Memory directory \`${dir.path}\` could not be read: ${(err as Error).message}`;
  }

  const truncated = text.length > MAX_INSTRUCTIONS;
  const body = truncated ? `${text.slice(0, MAX_INSTRUCTIONS)}\n\n[truncated]` : text;

  return [
    `The memory directory \`${dir.path}\` describes itself as follows.`,
    truncated
      ? `Its ${MEMORY_INSTRUCTIONS_FILE} is longer than fits here; read the file for the rest.`
      : "",
    "",
    body,
  ]
    .filter((line, i) => line !== "" || i > 1)
    .join("\n");
}

/** For a store that does not explain itself: what is in it, one level deep. */
function listing(dir: ResolvedMemoryDir): string {
  let names: string[];
  try {
    names = readdirSync(dir.path)
      .filter((name) => !name.startsWith("."))
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    return `Memory directory \`${dir.path}\` could not be listed: ${(err as Error).message}`;
  }

  const shown = names.slice(0, MAX_LISTED_ENTRIES).map((name) => {
    let isDir = false;
    try {
      isDir = statSync(path.join(dir.path, name)).isDirectory();
    } catch {
      isDir = false;
    }
    return isDir ? `- ${name}/` : `- ${name}`;
  });

  const rest = names.length - shown.length;
  return [
    `The memory directory \`${dir.path}\` has no ${MEMORY_INSTRUCTIONS_FILE}, so here is what it contains.`,
    "",
    ...shown,
    rest > 0 ? `- …and ${rest} more` : "",
    "",
    "Explore it with your file tools before relying on it.",
  ]
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n");
}
