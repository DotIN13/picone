import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GlobalSettings, WorkspaceMcpConfig, WorkspaceSkill } from "@picone/protocol";
import { DATA_DIR, ensureDataDir } from "./config.ts";

/**
 * Settings that apply to every workspace.
 *
 * Pi already discovers global skills, extensions, and prompt templates from
 * `~/.pi/agent` and `~/.agents`, so those need nothing from us; which of them a
 * workspace uses is recorded in its own file, under `disabled`. This file is
 * for what has nowhere else to live: extra skill directories, and MCP servers,
 * which Pi has no concept of. It has no UI — edit it by hand.
 */
export const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const EMPTY: GlobalSettings = { mcp: {}, skills: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMcp(raw: unknown, errors: string[]): Record<string, WorkspaceMcpConfig> {
  if (!isRecord(raw)) return {};
  const out: Record<string, WorkspaceMcpConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      errors.push(`"mcp.${name}" must be an object`);
      continue;
    }
    if (typeof value.command !== "string" && typeof value.url !== "string") {
      errors.push(`"mcp.${name}" needs either "command" (stdio) or "url" (http)`);
      continue;
    }
    out[name] = {
      command: typeof value.command === "string" ? value.command : undefined,
      args: Array.isArray(value.args) ? value.args.filter((a): a is string => typeof a === "string") : undefined,
      env: isRecord(value.env) ? (value.env as Record<string, string>) : undefined,
      url: typeof value.url === "string" ? value.url : undefined,
      headers: isRecord(value.headers) ? (value.headers as Record<string, string>) : undefined,
      enabled: value.enabled === undefined ? true : Boolean(value.enabled),
    };
  }
  return out;
}

function parseSkills(raw: unknown, errors: string[]): WorkspaceSkill[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`"skills" must be an array`);
    return [];
  }
  const out: WorkspaceSkill[] = [];
  raw.forEach((entry, i) => {
    if (typeof entry === "string") {
      out.push({ name: path.basename(entry), path: entry });
      return;
    }
    if (!isRecord(entry) || typeof entry.path !== "string") {
      errors.push(`"skills[${i}]" must be a path, or { name, path }`);
      return;
    }
    out.push({ name: typeof entry.name === "string" ? entry.name : path.basename(entry.path), path: entry.path });
  });
  return out;
}

export interface LoadedSettings {
  settings: GlobalSettings;
  errors: string[];
}

export function loadGlobalSettings(): LoadedSettings {
  if (!existsSync(SETTINGS_PATH)) return { settings: { ...EMPTY }, errors: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch (err) {
    return { settings: { ...EMPTY }, errors: [`settings.json is not valid JSON: ${(err as Error).message}`] };
  }

  if (!isRecord(raw)) return { settings: { ...EMPTY }, errors: ["settings.json must be a JSON object"] };

  const errors: string[] = [];
  // `mcpServers` is what Claude Desktop and Cursor call it; accept both so a
  // config can be pasted across without renaming the key.
  const mcp = { ...parseMcp(raw.mcpServers, errors), ...parseMcp(raw.mcp, errors) };

  if (raw.disabledExtensions !== undefined) {
    errors.push(`"disabledExtensions" is ignored — extensions are switched off per workspace, under "disabled"`);
  }

  return { settings: { mcp, skills: parseSkills(raw.skills, errors) }, errors };
}

export function saveGlobalSettings(settings: GlobalSettings): LoadedSettings {
  ensureDataDir();
  const clean: GlobalSettings = {
    mcp: settings.mcp ?? {},
    skills: (settings.skills ?? []).filter((s) => s.path.trim() !== ""),
  };
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  return loadGlobalSettings();
}

/**
 * Global servers first, then the workspace's — so a workspace can override a
 * global entry by name, including setting `enabled: false` to turn it off here.
 */
export function mergeMcp(
  global: Record<string, WorkspaceMcpConfig> | undefined,
  workspace: Record<string, WorkspaceMcpConfig> | undefined,
): { merged: Record<string, WorkspaceMcpConfig>; sources: Record<string, "global" | "workspace"> } {
  const merged: Record<string, WorkspaceMcpConfig> = {};
  const sources: Record<string, "global" | "workspace"> = {};

  for (const [name, config] of Object.entries(global ?? {})) {
    merged[name] = config;
    sources[name] = "global";
  }
  for (const [name, config] of Object.entries(workspace ?? {})) {
    merged[name] = config;
    sources[name] = "workspace";
  }
  return { merged, sources };
}
