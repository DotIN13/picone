import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWorkspaceFile } from "./schema.ts";

/**
 * The validator is a whitelist, which means a field it does not know about is
 * dropped on the next write rather than rejected. That is the right behaviour
 * and a trap for every new field: choosing Claude wrote the workspace file and
 * the choice vanished, silently, because `agent` was not listed here yet.
 */
test("the agent and its models survive a round trip", () => {
  const { file, errors } = validateWorkspaceFile({
    version: 1,
    name: "w",
    cwd: "/tmp",
    agent: "claude",
    models: { claude: { model: "sonnet", thinking: "high" }, pi: { provider: "deepseek", model: "deepseek-v4-flash" } },
  });
  assert.deepEqual(errors, []);
  assert.equal(file?.agent, "claude");
  assert.equal(file?.models?.claude?.model, "sonnet");
  assert.equal(file?.models?.pi?.provider, "deepseek");
});

test("an agent nobody has heard of is refused rather than dropped", () => {
  const { file, errors } = validateWorkspaceFile({ version: 1, name: "w", cwd: "/tmp", agent: "gpt" });
  assert.equal(file, null);
  assert.match(errors.join(" "), /"agent" must be/);
});

test("the single model slot still means Pi's", () => {
  // Older files say `model` and nothing else; that has to keep working (§57).
  const { file, errors } = validateWorkspaceFile({
    version: 1,
    name: "w",
    cwd: "/tmp",
    model: { provider: "deepseek", model: "deepseek-v4-flash", thinking: "high" },
  });
  assert.deepEqual(errors, []);
  assert.equal(file?.model?.model, "deepseek-v4-flash");
  assert.equal(file?.models, undefined);
});
