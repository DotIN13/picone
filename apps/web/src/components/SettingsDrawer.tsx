import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { unwrap } from "solid-js/store";
import type {
  ModelOption,
  PermissionSetting,
  ResourceInfo,
  ThinkingLevel,
  WorkspaceFile,
  WorkspaceResources,
} from "@picone/protocol";
import { api } from "../lib/api.ts";
import { openFile, refreshState, setSettingsOpen, state } from "../store.ts";
import { Drawer } from "./ui/drawer.tsx";
import { Button, IconButton } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Select, Switch, Tag, TextArea, TextInput } from "./ui/primitives.tsx";
import { AppearancePanel, NotificationsPanel } from "./AppSettings.tsx";

type Section =
  | "general"
  | "directories"
  | "skills"
  | "prompts"
  | "extensions"
  | "permissions"
  | "voice"
  | "model"
  | "appearance"
  | "notifications";

interface SectionItem {
  id: Section;
  label: string;
  icon: Parameters<typeof Icon>[0]["name"];
}

/**
 * Two groups, because the two halves answer to different owners: the workspace
 * sections are written to a JSON file that travels with the project, and the
 * app sections describe this browser on this device (DESIGN §49).
 */
const GROUPS: Array<{ title: string; scope: "workspace" | "app"; items: SectionItem[] }> = [
  {
    title: "Workspace",
    scope: "workspace",
    items: [
      { id: "general", label: "General", icon: "settings" },
      { id: "directories", label: "Directories", icon: "folder" },
      { id: "skills", label: "Skills", icon: "sparkle" },
      { id: "prompts", label: "Prompts", icon: "comment" },
      { id: "extensions", label: "Extensions", icon: "plug" },
      { id: "permissions", label: "Permissions", icon: "shield" },
      { id: "voice", label: "Voice", icon: "mic" },
      { id: "model", label: "Model", icon: "terminal" },
    ],
  },
  {
    title: "App",
    scope: "app",
    items: [
      { id: "appearance", label: "Appearance", icon: "sun" },
      { id: "notifications", label: "Notifications", icon: "alert" },
    ],
  },
];

const APP_SECTIONS = new Set<Section>(GROUPS.find((g) => g.scope === "app")!.items.map((i) => i.id));

const PERMISSION_OPTIONS = (["allow", "ask", "deny"] as PermissionSetting[]).map((value) => ({
  value,
  label: value,
}));

/** Used only when no concrete model is chosen and capabilities are unknown. */
const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];


/** Workspace settings (DESIGN §35) and app settings (§49), in one side drawer. */
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

  /**
   * Thinking levels the selected model accepts. With "Pi default" there is no
   * model to ask, so offer all of them and let Pi clamp — hiding the control
   * there would remove the setting rather than tailor it.
   */
  const thinkingOptions = createMemo(() => {
    const model = draft()?.model;
    const levels =
      model?.provider && model.model
        ? (models().find((m) => m.provider === model.provider && m.id === model.model)?.thinkingLevels ?? [])
        : ALL_THINKING_LEVELS;
    return levels.map((value) => ({ value, label: value }));
  });

  /** App settings are reachable with no workspace open; workspace ones are not. */
  const current = createMemo<Section>(() =>
    !state.workspace && !APP_SECTIONS.has(section()) ? "appearance" : section(),
  );

  return (
    <Drawer open={state.settingsOpen} onOpenChange={setSettingsOpen} side={state.compact ? "bottom" : "right"}>
      <div data-slot="drawer-header">
        <Icon name="settings" size={15} class="text-v2-icon-icon-muted" />
        <span data-slot="drawer-title">Settings</span>
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
          <For each={GROUPS}>
            {(group) => (
              <>
                <div data-slot="settings-nav-group">{group.title}</div>
                <For each={group.items}>
                  {(item) => (
                    <button
                      type="button"
                      data-slot="settings-nav-item"
                      data-active={current() === item.id ? "" : undefined}
                      disabled={group.scope === "workspace" && !state.workspace}
                      onClick={() => setSection(item.id)}
                    >
                      <Icon name={item.icon} size={13} />
                      {item.label}
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </nav>

        <div data-slot="settings-panel">
          <Show when={current() === "appearance"}>
            <AppearancePanel />
          </Show>
          <Show when={current() === "notifications"}>
            <NotificationsPanel />
          </Show>

          <Show when={draft()}>
            {(file) => (
              <>
                <Show when={current() === "general"}>
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

                  {/* `~/.picone/settings.json` has no UI, so its problems have
                      to surface somewhere the user will actually look. */}
                  <Show when={state.settingsErrors.length > 0}>
                    <div data-slot="settings-diagnostics">
                      <div data-slot="section-title">settings.json</div>
                      <ul class="flex list-disc flex-col gap-1 pl-4">
                        <For each={state.settingsErrors}>{(message) => <li>{message}</li>}</For>
                      </ul>
                    </div>
                  </Show>
                </Show>

                <Show when={current() === "directories"}>
                  <StringListEditor
                    label="Directories"
                    placeholder="/path/to/repo"
                    values={file().directories}
                    onChange={(directories) => patch({ directories })}
                  />
                </Show>

                <Show when={current() === "skills"}>
                  <ResourceToggles
                    title="Skills"
                    hint="Loaded by Pi from ~/.pi/agent/skills and ~/.agents/skills, plus any directories this workspace adds. Write new ones there or with the CLI; here you choose which this workspace uses."
                    empty="Pi found no skills."
                    resources={state.resources?.skills}
                    configured={file().skills}
                    onChange={(skills) => patch({ skills })}
                  />
                </Show>

                <Show when={current() === "prompts"}>
                  <ResourceToggles
                    title="Prompt templates"
                    hint="Each one is a slash command in the composer. Switching a template off removes its command from new sessions."
                    empty="Pi found no prompt templates."
                    prefix="/"
                    resources={state.resources?.prompts}
                    configured={file().prompts}
                    onChange={(prompts) => patch({ prompts })}
                  />
                </Show>

                <Show when={current() === "extensions"}>
                  <ResourceToggles
                    title="Pi extensions"
                    hint="Discovered by Pi from its own settings and extension directories. Switching one off leaves it installed — Picone just stops loading it. Install and remove with pi install."
                    empty="No extensions loaded."
                    resources={state.resources?.extensions}
                    configured={file().extensions}
                    onChange={(extensions) => patch({ extensions })}
                  />
                </Show>

                <Show when={current() === "permissions"}>
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

                <Show when={current() === "voice"}>
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

                <Show when={current() === "model"}>
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
                        per model, and a model without thinking gets no row. */}
                    <Show when={thinkingOptions().length > 0}>
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
              </>
            )}
          </Show>
        </div>
      </div>

      {/* Only the workspace half has anything to save; app settings apply as
          they are changed, so a footer over them would invite a pointless click. */}
      <Show when={!APP_SECTIONS.has(current())}>
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

/**
 * What Pi discovered, with a switch each. There is no add button on purpose:
 * skills, prompt templates and extensions are created on disk or with the Pi
 * CLI, and the workspace file only records which of them this workspace wants.
 */
function ResourceToggles(props: {
  title: string;
  hint: string;
  empty: string;
  prefix?: string;
  resources: ResourceInfo[] | undefined;
  configured: WorkspaceResources | undefined;
  onChange: (resources: WorkspaceResources | undefined) => void;
}) {
  /** No entry means enabled — a resource is on until this workspace says otherwise. */
  const isOn = (name: string) => props.configured?.[name]?.enabled !== false;

  const toggle = (name: string, enabled: boolean) => {
    const next: WorkspaceResources = { ...props.configured, [name]: { ...props.configured?.[name], enabled } };
    props.onChange(Object.keys(next).length > 0 ? next : undefined);
  };

  return (
    <div class="flex flex-col gap-2">
      <div data-slot="section-title">{props.title}</div>
      <p data-slot="field-hint">{props.hint}</p>

      <Show when={(props.resources?.length ?? 0) > 0} fallback={<div data-slot="field-hint">{props.empty}</div>}>
        <For each={props.resources}>
          {(resource) => (
            <div data-slot="resource-row">
              <Switch
                checked={isOn(resource.name)}
                onChange={(enabled) => toggle(resource.name, enabled)}
                label={`${props.prefix ?? ""}${resource.name}`}
              />
              <span data-slot="resource-description" title={resource.description}>
                {resource.description}
              </span>
              <Show when={resource.error}>
                <Tag tone="danger">failed</Tag>
              </Show>
              <Show when={resource.source}>
                <span data-slot="resource-path" title={resource.source}>
                  {resource.source}
                </span>
              </Show>
            </div>
          )}
        </For>
      </Show>

      <p class="text-v2-text-text-muted">Takes effect in sessions started after saving.</p>
    </div>
  );
}
