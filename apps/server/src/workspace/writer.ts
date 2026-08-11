import { writeFileSync } from "node:fs";
import type { Workspace, WorkspaceFile } from "@picone/protocol";
import { loadWorkspace } from "./loader.ts";
import { validateWorkspaceFile } from "./schema.ts";

/**
 * Workspace edits go back to the JSON file (DESIGN §34) — it stays the source of
 * truth, so the file remains readable and diffable after UI edits.
 */
export function writeWorkspaceFile(filePath: string, file: WorkspaceFile): Workspace {
  const { file: validated, errors } = validateWorkspaceFile(file);
  if (!validated) throw new Error(`Refusing to write invalid workspace file: ${errors.join("; ")}`);

  writeFileSync(filePath, `${JSON.stringify(stripUndefined(validated), null, 2)}\n`, "utf8");
  return loadWorkspace(filePath);
}

/** Keep the written JSON clean: no `"skills": null` noise from optional fields. */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}
