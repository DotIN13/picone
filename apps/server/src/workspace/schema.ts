import { asWorkspaceDir } from "@picone/protocol";
import type {
  MemoryDirs,
  PermissionSetting,
  WorkspaceDir,
  WorkspaceDirRef,
  WorkspaceFile,
  WorkspaceMcpConfig,
  WorkspaceModel,
  WorkspaceResources,
} from "@picone/protocol";

/**
 * Hand-written validation. The schema is deliberately small (DESIGN §4) and the
 * error messages are meant to be readable by whoever wrote the JSON by hand.
 */
export interface ValidationResult {
  file: WorkspaceFile | null;
  errors: string[];
  warnings: string[];
}

const PERMISSION_VALUES: PermissionSetting[] = ["allow", "ask", "deny"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(value: unknown, field: string, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    errors.push(`"${field}" must be an array of strings`);
    return undefined;
  }
  return value as string[];
}

/**
 * Context directories, in either form (§3).
 *
 * A path on its own is the usual entry. The object form carries a flag beside
 * it — today only `hidden`, which opens a directory without drawing it — and is
 * kept in whichever form it was written, so a hand-edited file comes back out
 * looking the way its author left it.
 */
function dirRefArray(value: unknown, field: string, errors: string[]): WorkspaceDirRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`"${field}" must be an array of paths`);
    return [];
  }

  const out: WorkspaceDirRef[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (entry && typeof entry === "object" && typeof (entry as WorkspaceDir).path === "string") {
      const { path, hidden } = entry as WorkspaceDir;
      if (hidden !== undefined && typeof hidden !== "boolean") {
        errors.push(`"${field}" entries may set "hidden" to true or false`);
        continue;
      }
      out.push(hidden ? { path, hidden: true } : path);
      continue;
    }
    errors.push(`"${field}" entries must be a path, or an object with a "path"`);
  }
  return out;
}

function permission(value: unknown, field: string, errors: string[]): PermissionSetting | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PERMISSION_VALUES.includes(value as PermissionSetting)) {
    errors.push(`"${field}" must be one of ${PERMISSION_VALUES.join(", ")}`);
    return undefined;
  }
  return value as PermissionSetting;
}

export function validateWorkspaceFile(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(raw)) {
    return { file: null, errors: ["Workspace file must be a JSON object"], warnings };
  }

  if (raw.version !== 1) {
    errors.push(`"version" must be 1 (got ${JSON.stringify(raw.version)})`);
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    errors.push(`"name" must be a non-empty string`);
  }

  /*
   * A workspace names one working directory and any number of directories open
   * beside it (§3). `directories` is the flat list this replaced and is still
   * accepted, so an older file opens without being touched: its first entry
   * becomes the cwd and the rest become context.
   */
  const directories = stringArray(raw.directories, "directories", errors) ?? [];
  const context = dirRefArray(raw.context, "context", errors);

  /* Same two forms as a context entry: a path, or a path saying more (§3). */
  let cwd: WorkspaceDirRef | undefined;
  if (raw.cwd !== undefined) {
    const [parsed] = dirRefArray([raw.cwd], "cwd", errors);
    if (parsed === undefined) {
      // dirRefArray has already said why.
    } else if (asWorkspaceDir(parsed).path.trim() === "") {
      errors.push(`"cwd" must be a non-empty path`);
    } else {
      cwd = parsed;
    }
  }

  if (raw.cwd === undefined && raw.directories === undefined) {
    errors.push(`"cwd" is required (or the older "directories")`);
  }
  if (cwd === undefined && directories.length === 0 && context.length === 0) {
    warnings.push(`this workspace opens no directories — the agent will have nowhere to work`);
  }

  const instructions = stringArray(raw.instructions, "instructions", errors);

  let skillPaths = stringArray(raw.skillPaths, "skillPaths", errors);

  /**
   * One switch per discovered resource, keyed by the name Pi knows it under.
   * An entry that only says `enabled: true` is kept: it is a decision the user
   * made, and the object is where anything else about the resource will go.
   */
  const resources = (value: unknown, field: string): WorkspaceResources | undefined => {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
      errors.push(`"${field}" must be an object keyed by name`);
      return undefined;
    }
    const out: WorkspaceResources = {};
    for (const [name, entry] of Object.entries(value)) {
      if (!isRecord(entry)) {
        errors.push(`"${field}.${name}" must be an object, e.g. { "enabled": false }`);
        continue;
      }
      out[name] = { enabled: entry.enabled === undefined ? undefined : Boolean(entry.enabled) };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  // `skills` used to be the list of extra skill directories, before it became
  // the switches. Keep old files loading, and say where the entries went.
  let skills: WorkspaceResources | undefined;
  if (Array.isArray(raw.skills)) {
    const legacy: string[] = [];
    raw.skills.forEach((s, i) => {
      if (typeof s === "string") legacy.push(s);
      else if (isRecord(s) && typeof s.path === "string") legacy.push(s.path);
      else errors.push(`"skills[${i}]" must be a path — extra skill directories now live in "skillPaths"`);
    });
    if (legacy.length) {
      warnings.push(`"skills" as a list of directories is deprecated; those paths were read as "skillPaths"`);
      skillPaths = [...(skillPaths ?? []), ...legacy];
    }
  } else {
    skills = resources(raw.skills, "skills");
  }

  const prompts = resources(raw.prompts, "prompts");
  const extensions = resources(raw.extensions, "extensions");

  /** Like `resources`, plus the two fields a memory directory adds (§50). */
  let memory: WorkspaceFile["memory"];
  if (raw.memory !== undefined) {
    if (!isRecord(raw.memory)) {
      errors.push(`"memory" must be an object keyed by name`);
    } else {
      const out: MemoryDirs = {};
      for (const [name, entry] of Object.entries(raw.memory)) {
        if (typeof entry === "string") {
          // A bare path is the obvious thing to write by hand; accept it.
          out[name] = { path: entry };
          continue;
        }
        if (!isRecord(entry)) {
          errors.push(`"memory.${name}" must be a path, or { "path": …, "enabled": …, "writable": …, "hidden": … }`);
          continue;
        }
        if (entry.path !== undefined && typeof entry.path !== "string") {
          errors.push(`"memory.${name}.path" must be a string`);
          continue;
        }
        out[name] = {
          path: typeof entry.path === "string" ? entry.path : undefined,
          enabled: entry.enabled === undefined ? undefined : Boolean(entry.enabled),
          writable: entry.writable === undefined ? undefined : Boolean(entry.writable),
          hidden: entry.hidden === undefined ? undefined : Boolean(entry.hidden),
        };
      }
      if (Object.keys(out).length > 0) memory = out;
    }
  }

  let mcp: Record<string, WorkspaceMcpConfig> | undefined;
  if (raw.mcp !== undefined) {
    if (!isRecord(raw.mcp)) {
      errors.push(`"mcp" must be an object keyed by server name`);
    } else {
      mcp = {};
      for (const [name, cfg] of Object.entries(raw.mcp)) {
        if (!isRecord(cfg)) {
          errors.push(`"mcp.${name}" must be an object`);
          continue;
        }
        if (cfg.command === undefined && cfg.url === undefined) {
          errors.push(`"mcp.${name}" needs either "command" (stdio) or "url" (http)`);
          continue;
        }
        mcp[name] = {
          command: typeof cfg.command === "string" ? cfg.command : undefined,
          args: stringArray(cfg.args, `mcp.${name}.args`, errors),
          env: isRecord(cfg.env) ? (cfg.env as Record<string, string>) : undefined,
          url: typeof cfg.url === "string" ? cfg.url : undefined,
          headers: isRecord(cfg.headers) ? (cfg.headers as Record<string, string>) : undefined,
          enabled: cfg.enabled === undefined ? true : Boolean(cfg.enabled),
        };
      }
    }
  }

  let permissions: WorkspaceFile["permissions"];
  if (raw.permissions !== undefined) {
    if (!isRecord(raw.permissions)) {
      errors.push(`"permissions" must be an object`);
    } else {
      permissions = {
        files: permission(raw.permissions.files, "permissions.files", errors),
        shell: permission(raw.permissions.shell, "permissions.shell", errors),
        git: permission(raw.permissions.git, "permissions.git", errors),
      };
    }
  }

  const modelEntry = (value: unknown, field: string): WorkspaceModel | undefined => {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
      errors.push(`"${field}" must be an object`);
      return undefined;
    }
    return {
      provider: typeof value.provider === "string" ? value.provider : undefined,
      model: typeof value.model === "string" ? value.model : undefined,
      thinking: typeof value.thinking === "string" ? value.thinking : undefined,
    };
  };

  const model = modelEntry(raw.model, "model");

  /**
   * Which agent new sessions start with, and the model each agent was last
   * given (§58). Per agent because they do not share a catalogue.
   */
  let agent: WorkspaceFile["agent"];
  if (raw.agent !== undefined) {
    if (raw.agent === "pi" || raw.agent === "claude") agent = raw.agent;
    else errors.push(`"agent" must be "pi" or "claude" (got ${JSON.stringify(raw.agent)})`);
  }

  let models: WorkspaceFile["models"];
  if (raw.models !== undefined) {
    if (!isRecord(raw.models)) {
      errors.push(`"models" must be an object keyed by agent`);
    } else {
      const out: NonNullable<WorkspaceFile["models"]> = {};
      for (const [name, entry] of Object.entries(raw.models)) {
        if (name !== "pi" && name !== "claude") {
          errors.push(`"models.${name}" is not an agent this version knows about`);
          continue;
        }
        const parsed = modelEntry(entry, `models.${name}`);
        if (parsed) out[name] = parsed;
      }
      if (Object.keys(out).length > 0) models = out;
    }
  }

  let voice: WorkspaceFile["voice"];
  if (raw.voice !== undefined) {
    if (!isRecord(raw.voice)) {
      errors.push(`"voice" must be an object`);
    } else {
      voice = {
        input: raw.voice.input === undefined ? undefined : Boolean(raw.voice.input),
        output: raw.voice.output === undefined ? undefined : Boolean(raw.voice.output),
      };
    }
  }

  if (errors.length > 0) return { file: null, errors, warnings };

  return {
    file: {
      version: 1,
      name: String(raw.name),
      cwd,
      context: context.length ? context : undefined,
      directories: directories.length ? directories : undefined,
      instructions,
      skillPaths: skillPaths?.length ? skillPaths : undefined,
      skills,
      prompts,
      extensions,
      memory,
      mcp,
      permissions,
      agent,
      models,
      model,
      voice,
    },
    errors,
    warnings,
  };
}

/** Defaults applied when the workspace file omits a section. */
export function resolvedPermissions(file: WorkspaceFile): Required<NonNullable<WorkspaceFile["permissions"]>> {
  return {
    files: file.permissions?.files ?? "allow",
    shell: file.permissions?.shell ?? "ask",
    git: file.permissions?.git ?? "ask",
  };
}

export function resolvedVoice(file: WorkspaceFile): { input: boolean; output: boolean } {
  return { input: file.voice?.input ?? true, output: file.voice?.output ?? true };
}
