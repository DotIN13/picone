import type { PermissionSetting, WorkspaceFile, WorkspaceMcpConfig, WorkspaceSkill } from "@picone/protocol";

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

  const directories = stringArray(raw.directories, "directories", errors) ?? [];
  if (raw.directories === undefined) {
    errors.push(`"directories" is required`);
  } else if (directories.length === 0) {
    warnings.push(`"directories" is empty — the agent will have no roots to work in`);
  }

  const instructions = stringArray(raw.instructions, "instructions", errors);

  let skills: WorkspaceSkill[] | undefined;
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) {
      errors.push(`"skills" must be an array`);
    } else {
      skills = [];
      raw.skills.forEach((s, i) => {
        if (!isRecord(s) || typeof s.name !== "string" || typeof s.path !== "string") {
          errors.push(`"skills[${i}]" must be { name: string, path: string }`);
          return;
        }
        skills!.push({ name: s.name, path: s.path });
      });
    }
  }

  let disabled: WorkspaceFile["disabled"];
  if (raw.disabled !== undefined) {
    if (!isRecord(raw.disabled)) {
      errors.push(`"disabled" must be an object with "skills", "prompts" and "extensions" arrays`);
    } else {
      // Empty lists are dropped so turning everything back on leaves the file
      // as it was before, rather than with `"disabled": {}` sitting in it.
      const keep = (value: string[] | undefined) => (value && value.length > 0 ? value : undefined);
      const next = {
        skills: keep(stringArray(raw.disabled.skills, "disabled.skills", errors)),
        prompts: keep(stringArray(raw.disabled.prompts, "disabled.prompts", errors)),
        extensions: keep(stringArray(raw.disabled.extensions, "disabled.extensions", errors)),
      };
      if (next.skills || next.prompts || next.extensions) disabled = next;
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

  let model: WorkspaceFile["model"];
  if (raw.model !== undefined) {
    if (!isRecord(raw.model)) {
      errors.push(`"model" must be an object`);
    } else {
      model = {
        provider: typeof raw.model.provider === "string" ? raw.model.provider : undefined,
        model: typeof raw.model.model === "string" ? raw.model.model : undefined,
        thinking: typeof raw.model.thinking === "string" ? raw.model.thinking : undefined,
      };
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
      directories,
      instructions,
      skills,
      disabled,
      mcp,
      permissions,
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
