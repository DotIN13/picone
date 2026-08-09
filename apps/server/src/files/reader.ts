import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { FileContent, FileKind } from "@picone/protocol";
import { MAX_FILE_BYTES } from "../config.ts";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".jsonc": "json",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".html": "html",
  ".htm": "html",
  ".vue": "html",
  ".svelte": "html",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".swift": "swift",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".ps1": "powershell",
  ".sql": "sql",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".ini": "ini",
  ".env": "shell",
  ".dockerfile": "dockerfile",
};

const TEXT_FILENAMES = new Set([
  "dockerfile",
  "makefile",
  "license",
  "readme",
  "changelog",
  ".gitignore",
  ".npmrc",
  ".editorconfig",
  ".env",
]);

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (LANGUAGE_BY_EXT[ext]) return LANGUAGE_BY_EXT[ext];
  const base = path.basename(filePath).toLowerCase();
  if (base.startsWith("dockerfile")) return "dockerfile";
  if (base === "makefile") return "makefile";
  return "plaintext";
}

export function detectKind(filePath: string, language: string, sample: Buffer): FileKind {
  if (looksBinary(sample)) return "binary";
  if (language === "markdown") return "markdown";
  if (language === "plaintext") {
    const base = path.basename(filePath).toLowerCase();
    return TEXT_FILENAMES.has(base) || path.extname(filePath) === ".txt" ? "text" : "text";
  }
  return "code";
}

/** A NUL byte in the first few KB is a good-enough binary heuristic. */
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 4096);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

export function readFileForTab(absPath: string): FileContent {
  const stat = statSync(absPath);
  if (!stat.isFile()) throw new Error(`Not a file: ${absPath}`);

  const language = detectLanguage(absPath);
  const truncated = stat.size > MAX_FILE_BYTES;
  const buf = readFileSync(absPath);
  const slice = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf;
  const kind = detectKind(absPath, language, slice);

  return {
    path: absPath,
    kind,
    language,
    content: kind === "binary" ? "" : slice.toString("utf8"),
    truncated,
    size: stat.size,
    mtime: stat.mtimeMs,
  };
}
