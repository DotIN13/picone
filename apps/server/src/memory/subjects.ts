import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { MemorySubject, ResolvedMemoryDir } from "@picone/protocol";
import { MEMORY_INDEX_FILE, MEMORY_INSTRUCTIONS_FILE } from "./registry.ts";

/**
 * The things in a memory directory that can be named with `@` (DESIGN §52).
 *
 * This index feeds the autocomplete menu, not the prompt. What the agent gets
 * from a mention is a path and an instruction to look wider — never a page.
 *
 * Nothing here invents a schema. A memory store is somebody's notes, so the
 * index reads what is there and degrades: no frontmatter still yields a
 * subject, it just has no type.
 */

/** The store's own furniture, not subjects in it. */
const NOT_SUBJECTS = new Set([MEMORY_INSTRUCTIONS_FILE.toLowerCase(), MEMORY_INDEX_FILE.toLowerCase(), "user.md", "readme.md"]);

/** Deep enough for `people/gio-choi.md`, shallow enough not to walk a repository. */
const MAX_DEPTH = 3;

/** A guard, not a policy: a store larger than this wants its own search. */
const MAX_SUBJECTS = 2000;

/** Only the first part of a page is read — enough for the heading and the lead. */
const HEAD_BYTES = 4096;

interface CacheEntry {
  /** Newest mtime seen anywhere in the tree, so an edit invalidates. */
  signature: string;
  subjects: MemorySubject[];
}

const cache = new Map<string, CacheEntry>();

export function memorySubjects(dirs: ResolvedMemoryDir[]): MemorySubject[] {
  const out: MemorySubject[] = [];
  for (const dir of dirs) {
    if (!dir.enabled || !dir.exists) continue;
    out.push(...subjectsIn(dir.path));
  }
  // Stable and alphabetical: the menu does its own ranking, and a list that
  // reorders itself between keystrokes is unusable.
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SUBJECTS);
}

function subjectsIn(root: string): MemorySubject[] {
  const files = walk(root, root, 0);
  const signature = files.map((f) => `${f.path}:${f.mtime}`).join("|");

  const hit = cache.get(root);
  if (hit && hit.signature === signature) return hit.subjects;

  const subjects = files.map((file) => read(file.path, root)).filter((s): s is MemorySubject => s !== null);
  cache.set(root, { signature, subjects });
  return subjects;
}

function walk(dir: string, root: string, depth: number): Array<{ path: string; mtime: number }> {
  if (depth > MAX_DEPTH) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const out: Array<{ path: string; mtime: number }> = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);

    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      out.push(...walk(full, root, depth + 1));
      continue;
    }
    if (!name.toLowerCase().endsWith(".md")) continue;
    // The store's own instructions and catalog are not subjects, but only at
    // the top level: a `people/index.md` is a page like any other.
    if (dir === root && NOT_SUBJECTS.has(name.toLowerCase())) continue;

    out.push({ path: full, mtime: stat.mtimeMs });
  }
  return out;
}

function read(file: string, root: string): MemorySubject | null {
  // Only the head: these pages run to thousands of words and all we want from
  // them is the frontmatter, the title and the lead.
  let head: string;
  let handle: number | undefined;
  try {
    handle = openSync(file, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytes = readSync(handle, buffer, 0, HEAD_BYTES, 0);
    head = buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return null;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }

  const { frontmatter, body } = splitFrontmatter(head);
  const slug = path.basename(file, path.extname(file));

  return {
    slug,
    name: firstHeading(body) ?? slug,
    // A page that declares its type wins. One that does not is typed by where
    // it is filed, which is not a guess: a store that puts notes in `journal/`
    // has already said what they are. Reference memory declares `person`,
    // `entity` and `goal`, and leaves journal entries to the folder.
    type: scalar(frontmatter, "type") ?? folderType(file, root),
    summary: firstParagraph(body),
    path: file,
    root,
    tags: list(frontmatter, "tags"),
  };
}

function folderType(file: string, root: string): string {
  const parent = path.dirname(file);
  if (parent === root) return "";
  return path.basename(parent).toLowerCase();
}

// ---------------------------------------------------------------------------
// Reading just enough of a page
// ---------------------------------------------------------------------------

/**
 * A deliberately small YAML reader. The frontmatter we care about is scalars
 * and one flow list, and pulling in a parser to read `type: person` would be a
 * dependency for the sake of it.
 */
function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  if (!text.startsWith("---")) return { frontmatter: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: "", body: text };
  return { frontmatter: text.slice(3, end), body: text.slice(text.indexOf("\n", end + 1) + 1) };
}

function scalar(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") || undefined;
}

function list(frontmatter: string, key: string): string[] {
  const raw = scalar(frontmatter, key);
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function firstHeading(body: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(body);
  return match?.[1]?.trim();
}

function firstParagraph(body: string): string {
  const lines = body.split("\n");
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (collected.length > 0) break;
      continue;
    }
    // Skip the title and any structure above the lead.
    if (trimmed.startsWith("#") || trimmed.startsWith("---")) {
      if (collected.length > 0) break;
      continue;
    }
    collected.push(trimmed);
  }
  const text = collected.join(" ");
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

// ---------------------------------------------------------------------------
// Mentions in a message
// ---------------------------------------------------------------------------

/**
 * `@slug` in a message, matched at a word boundary so an email address is not
 * a mention. Slugs are filenames, so the character class is the one filenames
 * actually use.
 */
const MENTION = /(^|[\s([{"'])@([a-z0-9][a-z0-9._-]*)/gi;

export function findMentions(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    const slug = match[2];
    // Trailing punctuation belongs to the sentence, not the name.
    if (slug) seen.add(slug.replace(/[.]+$/, "").toLowerCase());
  }
  return [...seen];
}

/**
 * What a mention contributes to the turn.
 *
 * A pointer, and an explicit instruction to look past it. The wording is doing
 * the work here: "here is where to start" leaves an agent free to search, while
 * anything that reads as "here is the relevant material" is how a capable agent
 * gets talked out of searching. Memory is scattered — a person turns up in
 * journal entries, in meeting notes, in someone else's `related:` list — so the
 * page filed under their name is a starting point and nothing more.
 *
 * Returns null when the message mentions nobody, so the common case adds
 * nothing to the prompt at all.
 */
export function mentionContext(text: string, subjects: MemorySubject[]): string | null {
  const slugs = findMentions(text);
  if (slugs.length === 0) return null;

  const bySlug = new Map(subjects.map((subject) => [subject.slug.toLowerCase(), subject]));
  const found = slugs.map((slug) => ({ slug, subject: bySlug.get(slug) }));
  if (found.every((entry) => !entry.subject) && subjects.length === 0) return null;

  const lines: string[] = ["The user named someone from memory in that message."];

  for (const { slug, subject } of found) {
    lines.push("");
    if (subject) {
      const kind = subject.type ? ` (${subject.type})` : "";
      lines.push(`**${subject.name}**${kind} — start here: \`${subject.path}\``);
    } else {
      // A missing page is not a missing person, and this is exactly the case
      // where searching is worth more than the pointer would have been.
      lines.push(`**@${slug}** — no page is filed under that name.`);
    }
  }

  lines.push("");
  lines.push(
    "These are starting points, not the record. Whoever was named may also appear in journal " +
      "entries, in meeting notes, and in other pages' `related` lists. Search the memory " +
      "directories before concluding something is not there, and read only what you need.",
  );

  return lines.join("\n");
}
