import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspacePermissions } from "@picone/protocol";
import { permissionsForMode } from "./modes.ts";

const asking: Required<WorkspacePermissions> = { files: "ask", shell: "ask", git: "ask" };

test("manual and plan leave the settings exactly as written", () => {
  // Plan mode changes nothing here on purpose: the session refuses writes on
  // top of these, so leaving plan mode has nothing to restore.
  assert.deepEqual(permissionsForMode("manual", asking), asking);
  assert.deepEqual(permissionsForMode("plan", asking), asking);
});

test("edit stops asking about files, and only files", () => {
  assert.deepEqual(permissionsForMode("edit", asking), { files: "allow", shell: "ask", git: "ask" });
});

test("auto stops asking about everything", () => {
  assert.deepEqual(permissionsForMode("auto", asking), { files: "allow", shell: "allow", git: "allow" });
});

test("an explicit deny outranks every mode", () => {
  // The user has already decided. A mode may stop Picone *asking*; it may not
  // overturn an answer that was given.
  const denied: Required<WorkspacePermissions> = { files: "deny", shell: "deny", git: "deny" };
  for (const mode of ["manual", "edit", "plan", "auto"] as const) {
    assert.deepEqual(permissionsForMode(mode, denied), denied, mode);
  }
});

test("an explicit allow is left alone too", () => {
  const allowed: Required<WorkspacePermissions> = { files: "allow", shell: "allow", git: "allow" };
  assert.deepEqual(permissionsForMode("edit", allowed), allowed);
  assert.deepEqual(permissionsForMode("auto", allowed), allowed);
});
