import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import type { GlobalSettings } from "@picone/protocol";
import { saveGlobalSettings, showToast, state } from "../store.ts";
import { Button, IconButton } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Switch, Tag, TextInput } from "./ui/primitives.tsx";

/**
 * Settings that apply to every workspace.
 *
 * Pi already discovers global skills, extensions, and prompt templates from
 * `~/.pi/agent` and `~/.agents`, so those need no configuration here — they are
 * listed so you can see what is loaded, and switched off if you do not want
 * them in Picone. MCP is different: Pi has no MCP of its own, so without this
 * every workspace file would have to repeat the same servers.
 */
export function GlobalSettingsPanel() {
  const [draft, setDraft] = createSignal<GlobalSettings>(snapshot());
  const [saving, setSaving] = createSignal(false);

  function snapshot(): GlobalSettings {
    return structuredClone(unwrap(state.settings));
  }

  createEffect(() => {
    state.settings;
    setDraft(snapshot());
  });

  const dirty = createMemo(() => JSON.stringify(draft()) !== JSON.stringify(state.settings));

  const patch = (changes: Partial<GlobalSettings>) => setDraft({ ...draft(), ...changes });

  const save = async () => {
    setSaving(true);
    try {
      await saveGlobalSettings(draft());
    } catch (err) {
      showToast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const toggleExtension = (name: string, enabled: boolean) => {
    const disabled = new Set(draft().disabledExtensions);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    patch({ disabledExtensions: [...disabled] });
  };

  return (
    <div class="flex flex-col gap-5">
      <Show when={state.settingsErrors.length > 0}>
        <div data-slot="settings-diagnostics">
          <div data-slot="section-title">settings.json</div>
          <ul class="flex list-disc flex-col gap-1 pl-4">
            <For each={state.settingsErrors}>{(message) => <li>{message}</li>}</For>
          </ul>
        </div>
      </Show>

      {/* ── MCP ── */}
      <div class="flex flex-col gap-2">
        <div data-slot="section-title">MCP servers for every workspace</div>
        <p data-slot="field-hint">
          A workspace can override any of these by name, including switching one off. Changes restart the servers
          immediately.
        </p>

        <For each={Object.entries(draft().mcp)}>
          {([name, config]) => {
            const status = () => state.mcp.find((m) => m.name === name);
            return (
              <div data-slot="mcp-card">
                <div class="flex items-center gap-2">
                  <Switch
                    checked={config.enabled !== false}
                    onChange={(enabled) => patch({ mcp: { ...draft().mcp, [name]: { ...config, enabled } } })}
                    label={<strong>{name}</strong>}
                  />
                  <span class="flex-1" />
                  <Show when={status()}>
                    {(s) => (
                      <Tag
                        tone={s().status === "connected" ? "success" : s().status === "error" ? "danger" : "neutral"}
                      >
                        {s().status}
                        <Show when={s().status === "connected"}> · {s().toolCount} tools</Show>
                      </Tag>
                    )}
                  </Show>
                  <Show when={status()?.source === "workspace"}>
                    <Tag tone="info">overridden</Tag>
                  </Show>
                  <IconButton
                    icon="close"
                    label={`Remove ${name}`}
                    onClick={() => {
                      const next = { ...draft().mcp };
                      delete next[name];
                      patch({ mcp: next });
                    }}
                  />
                </div>
                <div class="flex gap-2">
                  <TextInput
                    value={config.command ?? ""}
                    placeholder="command (stdio)"
                    onValue={(command) =>
                      patch({ mcp: { ...draft().mcp, [name]: { ...config, command: command || undefined } } })
                    }
                  />
                  <TextInput
                    value={config.url ?? ""}
                    placeholder="url (http)"
                    onValue={(url) => patch({ mcp: { ...draft().mcp, [name]: { ...config, url: url || undefined } } })}
                  />
                </div>
                <Show when={status()?.error}>
                  {(message) => <div class="text-[11.5px] text-v2-state-fg-danger">{message()}</div>}
                </Show>
              </div>
            );
          }}
        </For>

        <AddServer
          existing={Object.keys(draft().mcp)}
          onAdd={(name) => patch({ mcp: { ...draft().mcp, [name]: { enabled: true } } })}
        />
      </div>

      {/* ── Extra skill directories ── */}
      <div class="flex flex-col gap-2">
        <div data-slot="section-title">Extra skill directories</div>
        <p data-slot="field-hint">
          Pi already loads skills from <code>~/.pi/agent/skills</code> and <code>~/.agents/skills</code>. These are
          additional directories, loaded for every workspace.
        </p>
        <For each={draft().skills}>
          {(skill, index) => (
            <div class="flex items-end gap-2">
              <TextInput
                value={skill.path}
                placeholder="~/work/skills"
                onValue={(path) => {
                  const skills = [...draft().skills];
                  skills[index()] = { ...skill, path };
                  patch({ skills });
                }}
              />
              <IconButton
                icon="close"
                label="Remove"
                onClick={() => patch({ skills: draft().skills.filter((_, i) => i !== index()) })}
              />
            </div>
          )}
        </For>
        <Button
          variant="neutral"
          icon="plus"
          class="self-start"
          onClick={() => patch({ skills: [...draft().skills, { name: "", path: "" }] })}
        >
          Add directory
        </Button>
      </div>

      {/* ── Extensions ── */}
      <div class="flex flex-col gap-2">
        <div data-slot="section-title">Pi extensions</div>
        <p data-slot="field-hint">
          Discovered by Pi from its own settings and extension directories. Switching one off hides it from Picone
          only — install and remove with <code>pi install</code>. Takes effect in new sessions.
        </p>

        <Show
          when={(state.resources?.extensions.length ?? 0) > 0}
          fallback={<div data-slot="field-hint">No extensions loaded.</div>}
        >
          <For each={state.resources?.extensions}>
            {(extension) => (
              <div data-slot="resource-row">
                <Switch
                  checked={!draft().disabledExtensions.includes(extension.name)}
                  onChange={(enabled) => toggleExtension(extension.name, enabled)}
                  label={extension.name}
                />
                <span class="flex-1" />
                <Show when={extension.error}>
                  <Tag tone="danger">failed</Tag>
                </Show>
                <Show when={extension.path}>
                  <span data-slot="resource-path" title={extension.path}>
                    {extension.path}
                  </span>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>

      {/* ── What Pi loaded ── */}
      <details data-slot="resource-details">
        <summary>
          <Icon name="sparkle" size={12} />
          Loaded skills ({state.resources?.skills.length ?? 0}) and prompt templates (
          {state.resources?.prompts.length ?? 0})
        </summary>
        <div class="flex flex-col gap-1 pt-2">
          <For each={state.resources?.skills}>
            {(skill) => (
              <div data-slot="resource-row">
                <span class="font-[530]">{skill.name}</span>
                <span data-slot="resource-path" title={skill.source}>
                  {skill.source}
                </span>
              </div>
            )}
          </For>
          <For each={state.resources?.prompts}>
            {(prompt) => (
              <div data-slot="resource-row">
                <span class="font-[530]">/{prompt.name}</span>
                <span data-slot="resource-path" title={prompt.source}>
                  {prompt.source}
                </span>
              </div>
            )}
          </For>
        </div>
      </details>

      <div class="flex items-center gap-8">
        <span class="text-v2-text-text-muted">{dirty() ? "Unsaved changes" : "Saved"}</span>
        <span class="flex-1" />
        <Button variant="ghost" disabled={!dirty()} onClick={() => setDraft(snapshot())}>
          Revert
        </Button>
        <Button variant="contrast" disabled={!dirty() || saving()} onClick={() => void save()}>
          {saving() ? "Saving…" : "Save global settings"}
        </Button>
      </div>
    </div>
  );
}

function AddServer(props: { onAdd: (name: string) => void; existing: string[] }) {
  const [name, setName] = createSignal("");
  const valid = () => name().trim().length > 0 && !props.existing.includes(name().trim());
  return (
    <div class="flex items-end gap-2">
      <TextInput value={name()} placeholder="server name" onValue={setName} />
      <Button
        variant="neutral"
        icon="plus"
        disabled={!valid()}
        onClick={() => {
          props.onAdd(name().trim());
          setName("");
        }}
      >
        Add server
      </Button>
    </div>
  );
}
