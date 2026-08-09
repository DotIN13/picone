import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { unwrap } from "solid-js/store";
import type { ModelOption, PermissionSetting, WorkspaceFile } from "@picone/protocol";
import { api } from "../lib/api.ts";
import { openFile, refreshState, setSettingsOpen, state } from "../store.ts";
import { Drawer } from "./ui/drawer.tsx";
import { Button, IconButton } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Select, Switch, Tag, TextArea, TextInput } from "./ui/primitives.tsx";
import { GlobalSettingsPanel } from "./GlobalSettingsPanel.tsx";

type Section = "general" | "directories" | "skills" | "mcp" | "permissions" | "voice" | "model" | "global";

const SECTIONS: Array<{ id: Section; label: string; icon: Parameters<typeof Icon>[0]["name"] }> = [
  { id: "general", label: "General", icon: "settings" },
  { id: "directories", label: "Directories", icon: "folder" },
  { id: "skills", label: "Skills", icon: "sparkle" },
  { id: "mcp", label: "MCP", icon: "plug" },
  { id: "permissions", label: "Permissions", icon: "shield" },
  { id: "voice", label: "Voice", icon: "mic" },
  { id: "model", label: "Model", icon: "terminal" },
  { id: "global", label: "Global", icon: "git-branch" },
];

const PERMISSION_OPTIONS = (["allow", "ask", "deny"] as PermissionSetting[]).map((value) => ({
  value,
  label: value,
}));


/** Workspace settings (DESIGN §35), presented as a Corvu side drawer. */
export function SettingsDrawer() {
  const [section, setSection] = createSignal<Section>("general");
  const [draft, setDraft] = createSignal<WorkspaceFile | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [models, setModels] = createSignal<ModelOption[]>([]);

  onMount(() => {
    void api
      .models()
      .then(({ models: list }) => setModels(list))
      .catch(() => setModels([]));
  });

  // `unwrap` first: a store proxy is not structured-cloneable.
  const snapshot = (): WorkspaceFile | null =>
    state.workspace ? structuredClone(unwrap(state.workspace.file)) : null;

  createEffect(() => setDraft(snapshot()));

  const dirty = createMemo(() => JSON.stringify(draft()) !== JSON.stringify(state.workspace?.file ?? null));

  const patch = (changes: Partial<WorkspaceFile>) => {
    const current = draft();
    if (current) setDraft({ ...current, ...changes });
  };

  const save = async () => {
    const current = draft();
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveWorkspace(current);
      await refreshState();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const modelOptions = createMemo(() => [
    { value: "", label: "Pi default" },
    ...models().map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}` })),
  ]);

  /** Thinking levels the currently selected model actually accepts. */
  const thinkingOptions = createMemo(() => {
    const model = draft()?.model;
    if (!model?.provider || !model.model) return [];
    const option = models().find((m) => m.provider === model.provider && m.id === model.model);
    return (option?.thinkingLevels ?? []).map((value) => ({ value, label: value }));
  });

  return (
    <Drawer open={state.settingsOpen} onOpenChange={setSettingsOpen} side={state.compact ? "bottom" : "right"}>
      <Show when={draft()}>
        {(file) => (
          <>
            <div data-slot="drawer-header">
              <Icon name="settings" size={15} class="text-v2-icon-icon-muted" />
              <span data-slot="drawer-title">Workspace settings</span>
              <span class="flex-1" />
              <IconButton icon="close" label="Close settings" variant="ghost-muted" onClick={() => setSettingsOpen(false)} />
            </div>

            <Show when={error()}>
              {(message) => (
                <div data-slot="dialog-error" class="mx-3.5 mt-3">
                  <Icon name="alert" size={14} />
                  <span class="whitespace-pre-wrap">{message()}</span>
                </div>
              )}
            </Show>

            <div data-slot="drawer-body">
              <nav data-slot="settings-nav">
                <For each={SECTIONS}>
                  {(item) => (
                    <button
                      type="button"
                      data-slot="settings-nav-item"
                      data-active={section() === item.id ? "" : undefined}
                      onClick={() => setSection(item.id)}
                    >
                      <Icon name={item.icon} size={13} />
                      {item.label}
                    </button>
                  )}
                </For>
              </nav>

              <div data-slot="settings-panel">
                <Show when={section() === "general"}>
                  <TextInput label="Name" value={file().name} onValue={(name) => patch({ name })} />
                  <TextArea
                    label="Instructions (one per line)"
                    rows={6}
                    value={(file().instructions ?? []).join("\n")}
                    onValue={(value) =>
                      patch({
                        instructions: value
                          .split("\n")
                          .map((line) => line.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                  <div class="flex items-center gap-3">
                    <Button
                      variant="neutral"
                      icon="file"
                      onClick={() => {
                        void openFile(state.workspace!.path);
                        setSettingsOpen(false);
                      }}
                    >
                      Open workspace JSON
                    </Button>
                    <code data-slot="settings-path">{state.workspace?.path}</code>
                  </div>

                  <Show when={(state.workspace?.diagnostics.length ?? 0) > 0}>
                    <div data-slot="settings-diagnostics">
                      <div data-slot="section-title">Diagnostics</div>
                      <ul class="flex list-disc flex-col gap-1 pl-4">
                        <For each={state.workspace?.diagnostics}>{(d) => <li>{d}</li>}</For>
                      </ul>
                    </div>
                  </Show>
                </Show>

                <Show when={section() === "directories"}>
                  <StringListEditor
                    label="Directories"
                    placeholder="/path/to/repo"
                    values={file().directories}
                    onChange={(directories) => patch({ directories })}
                  />
                </Show>

                <Show when={section() === "skills"}>
                  <div class="flex flex-col gap-2">
                    <div data-slot="section-title">Skills</div>
                    <For each={file().skills ?? []}>
                      {(skill, index) => (
                        <div class="flex items-end gap-2">
                          <TextInput
                            value={skill.name}
                            placeholder="name"
                            onValue={(name) => {
                              const skills = [...(file().skills ?? [])];
                              skills[index()] = { ...skill, name };
                              patch({ skills });
                            }}
                          />
                          <TextInput
                            value={skill.path}
                            placeholder="~/.pi/agent/skills/release"
                            onValue={(path) => {
                              const skills = [...(file().skills ?? [])];
                              skills[index()] = { ...skill, path };
                              patch({ skills });
                            }}
                          />
                          <IconButton
                            icon="close"
                            label="Remove skill"
                            onClick={() => patch({ skills: (file().skills ?? []).filter((_, i) => i !== index()) })}
                          />
                        </div>
                      )}
                    </For>
                    <Button
                      variant="neutral"
                      icon="plus"
                      class="self-start"
                      onClick={() => patch({ skills: [...(file().skills ?? []), { name: "", path: "" }] })}
                    >
                      Add skill
                    </Button>
                  </div>
                </Show>

                <Show when={section() === "mcp"}>
                  <div class="flex flex-col gap-2">
                    <div data-slot="section-title">MCP servers</div>
                    <For each={Object.entries(file().mcp ?? {})}>
                      {([name, config]) => {
                        const status = () => state.mcp.find((m) => m.name === name);
                        return (
                          <div data-slot="mcp-card">
                            <div class="flex items-center gap-2">
                              <Switch
                                checked={config.enabled !== false}
                                onChange={(enabled) =>
                                  patch({ mcp: { ...file().mcp, [name]: { ...config, enabled } } })
                                }
                                label={<strong>{name}</strong>}
                              />
                              <span class="flex-1" />
                              <Show when={status()}>
                                {(s) => (
                                  <Tag
                                    tone={
                                      s().status === "connected" ? "success" : s().status === "error" ? "danger" : "neutral"
                                    }
                                  >
                                    {s().status}
                                    <Show when={s().status === "connected"}> · {s().toolCount} tools</Show>
                                  </Tag>
                                )}
                              </Show>
                              <IconButton
                                icon="close"
                                label={`Remove ${name}`}
                                onClick={() => {
                                  const next = { ...file().mcp };
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
                                  patch({ mcp: { ...file().mcp, [name]: { ...config, command: command || undefined } } })
                                }
                              />
                              <TextInput
                                value={config.url ?? ""}
                                placeholder="url (http)"
                                onValue={(url) =>
                                  patch({ mcp: { ...file().mcp, [name]: { ...config, url: url || undefined } } })
                                }
                              />
                            </div>
                            <Show when={status()?.error}>
                              {(message) => <div class="text-[11.5px] text-v2-state-fg-danger">{message()}</div>}
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                    <AddMcpServer
                      existing={Object.keys(file().mcp ?? {})}
                      onAdd={(name) => patch({ mcp: { ...(file().mcp ?? {}), [name]: { enabled: true } } })}
                    />
                  </div>
                </Show>

                <Show when={section() === "permissions"}>
                  <div class="flex flex-col gap-3">
                    <For each={["files", "shell", "git"] as const}>
                      {(category) => (
                        <div data-slot="settings-row">
                          <span class="capitalize">{category}</span>
                          <Select
                            aria-label={`${category} permission`}
                            width="140px"
                            value={file().permissions?.[category] ?? (category === "files" ? "allow" : "ask")}
                            options={PERMISSION_OPTIONS}
                            onChange={(value) =>
                              patch({ permissions: { ...file().permissions, [category]: value as PermissionSetting } })
                            }
                          />
                        </div>
                      )}
                    </For>
                    <p class="text-v2-text-text-muted">
                      Read-only git commands (status, diff, log) run without asking. Everything else follows the setting
                      above.
                    </p>
                  </div>
                </Show>

                <Show when={section() === "voice"}>
                  <div class="flex flex-col gap-3">
                    <Switch
                      checked={file().voice?.input ?? true}
                      onChange={(input) => patch({ voice: { ...file().voice, input } })}
                      label="Voice input (dictation in the composer)"
                    />
                    <Switch
                      checked={file().voice?.output ?? true}
                      onChange={(output) => patch({ voice: { ...file().voice, output } })}
                      label="Voice output (gives the agent a speak tool)"
                    />
                  </div>
                </Show>

                <Show when={section() === "model"}>
                  <div class="flex flex-col gap-3">
                    <div data-slot="settings-row">
                      <span>Model</span>
                      <Select
                        aria-label="Model"
                        width="280px"
                        value={
                          file().model?.provider && file().model?.model
                            ? `${file().model!.provider}/${file().model!.model}`
                            : ""
                        }
                        options={modelOptions()}
                        onChange={(value) => {
                          if (!value) {
                            patch({ model: { ...file().model, provider: undefined, model: undefined } });
                            return;
                          }
                          const [provider, ...rest] = value.split("/");
                          patch({ model: { ...file().model, provider, model: rest.join("/") } });
                        }}
                      />
                    </div>
                    {/* Only what the chosen model accepts — the levels differ
                        per model, so a fixed list would offer invalid ones. */}
                    <Show
                      when={thinkingOptions().length > 0}
                      fallback={
                        <p class="text-v2-text-text-muted">
                          {file().model?.model
                            ? "This model has no thinking control."
                            : "Choose a model to set a thinking level."}
                        </p>
                      }
                    >
                      <div data-slot="settings-row">
                        <span>Thinking</span>
                        <Select
                          aria-label="Thinking level"
                          width="140px"
                          value={file().model?.thinking ?? ""}
                          options={[{ value: "", label: "Pi default" }, ...thinkingOptions()]}
                          onChange={(thinking) => patch({ model: { ...file().model, thinking: thinking || undefined } })}
                        />
                      </div>
                    </Show>
                    <p class="text-v2-text-text-muted">Model changes apply to sessions created after saving.</p>
                  </div>
                </Show>

                <Show when={section() === "global"}>
                  <GlobalSettingsPanel />
                </Show>
              </div>
            </div>

            <div data-slot="drawer-footer">
              <span class="text-v2-text-text-muted">{dirty() ? "Unsaved changes" : "Saved"}</span>
              <span class="flex-1" />
              <Button variant="ghost" disabled={!dirty()} onClick={() => setDraft(snapshot())}>
                Revert
              </Button>
              <Button variant="contrast" disabled={!dirty() || saving()} onClick={() => void save()}>
                {saving() ? "Saving…" : "Save to workspace.json"}
              </Button>
            </div>
          </>
        )}
      </Show>
    </Drawer>
  );
}

function StringListEditor(props: {
  label: string;
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <div class="flex flex-col gap-2">
      <div data-slot="section-title">{props.label}</div>
      <For each={props.values}>
        {(value, index) => (
          <div class="flex items-end gap-2">
            <TextInput
              value={value}
              placeholder={props.placeholder}
              onValue={(next) => {
                const values = [...props.values];
                values[index()] = next;
                props.onChange(values);
              }}
            />
            <IconButton
              icon="close"
              label="Remove"
              onClick={() => props.onChange(props.values.filter((_, i) => i !== index()))}
            />
          </div>
        )}
      </For>
      <Button variant="neutral" icon="plus" class="self-start" onClick={() => props.onChange([...props.values, ""])}>
        Add
      </Button>
    </div>
  );
}

function AddMcpServer(props: { onAdd: (name: string) => void; existing: string[] }) {
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
