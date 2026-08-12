import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { unwrap } from "solid-js/store";
import { asWorkspaceDir } from "@picone/protocol";
import type {
  ModelOption,
  PermissionSetting,
  ResourceInfo,
  ThinkingLevel,
  WorkspaceDir,
  WorkspaceFile,
  WorkspaceResources,
} from "@picone/protocol";
import { api } from "../lib/api.ts";
import { openFile, refreshState, saveGlobalSettings, setSettingsOpen, state } from "../store.ts";
import { Drawer } from "./ui/drawer.tsx";
import { Button, IconButton } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Select, Switch, Tag, TextArea, TextInput } from "./ui/primitives.tsx";
import { AppearancePanel, NotificationsPanel } from "./AppSettings.tsx";
import { GlobalMemoryPanel, WorkspaceMemoryPanel } from "./MemorySettings.tsx";
import { DirectoryDialog } from "./DirectoryDialog.tsx";
import { resolveWorkspacePath } from "../lib/workspace-paths.ts";

type Section =
  | "general"
  | "directories"
  | "skills"
  | "prompts"
  | "extensions"
  | "permissions"
  | "voice"
  | "model"
  | "memory"
  | "appearance"
  | "notifications"
  | "app-memory";

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
    title: "App",
    scope: "app",
    items: [
      { id: "appearance", label: "Appearance", icon: "sun" },
      { id: "notifications", label: "Notifications", icon: "bell" },
      { id: "app-memory", label: "Memory", icon: "sparkle" },
    ],
  },
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
      { id: "memory", label: "Memory", icon: "sparkle" },
      { id: "voice", label: "Voice", icon: "mic" },
      { id: "model", label: "Model", icon: "terminal" },
    ],
  },
];

const APP_SECTIONS = new Set<Section>(GROUPS.find((g) => g.scope === "app")!.items.map((i) => i.id));

const SECTION_LABEL = new Map<Section, string>(
  GROUPS.flatMap((group) => group.items).map((item) => [item.id, item.label]),
);

const PERMISSION_OPTIONS = (["allow", "ask", "deny"] as PermissionSetting[]).map((value) => ({
  value,
  label: value,
}));

/** Used only when no concrete model is chosen and capabilities are unknown. */
const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];


/** Workspace settings (DESIGN §35) and app settings (§49), in one side drawer. */
export function SettingsDrawer() {
  const [section, setSection] = createSignal<Section>("appearance");
  /**
   * Compact layouts get the phone convention: a list of sections you tap into,
   * with a back arrow, rather than a rail of tabs that would need scrolling to
   * even see. On a wide screen the rail is always visible and this is ignored.
   */
  const [atIndex, setAtIndex] = createSignal(true);
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

  /*
   * Edits save themselves (DESIGN §35).
   *
   * There was a draft with a Save button, and the button is what people miss:
   * adding a directory through the chooser looks like an action that happened,
   * because it happened in a dialog with its own confirm — but it only touched
   * a draft, and closing the drawer threw it away. Everything the app settings
   * do already applied instantly; the workspace panel is the same kind of
   * surface and now behaves the same way.
   *
   * The draft still exists, one keystroke ahead of the file, so a text field
   * does not fight the round trip.
   */
  const [pending, setPending] = createSignal(false);
  let timer: number | undefined;

  createEffect(() => {
    const incoming = snapshot();
    // Not while an edit of ours is in flight: adopting the server's copy
    // mid-write would undo whatever has been typed since.
    if (pending() || saving()) return;
    setDraft(incoming);
  });

  onCleanup(() => {
    if (timer) window.clearTimeout(timer);
  });

  const patch = (changes: Partial<WorkspaceFile>) => {
    const current = draft();
    if (!current) return;
    const next = { ...current, ...changes };
    setDraft(next);

    /*
     * Coalesced, because a text field patches on every keystroke and each save
     * rewrites workspace.json and reloads the workspace behind it. Short enough
     * to feel immediate, long enough that typing a path is one write.
     */
    setPending(true);
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => void commit(next), 400);
  };

  const commit = async (file: WorkspaceFile) => {
    timer = undefined;
    setSaving(true);
    setPending(false);
    setError(null);
    try {
      await api.saveWorkspace(file);
      await refreshState();
    } catch (err) {
      // The draft keeps the rejected edit, so it can be corrected rather than
      // silently reverting to what is on disk.
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /*
   * What the workspace opens, read through the older flat list as well (§3).
   *
   * A file still using `directories` shows its first entry as the working
   * directory and the rest as context — the same reading the loader gives it —
   * so the panel matches the sidebar before anything is saved.
   */
  const openedCwd = () => {
    const f = draft();
    const entry = f?.cwd ?? f?.directories?.[0];
    return entry === undefined ? undefined : asWorkspaceDir(entry);
  };

  /**
   * The directories open beside the cwd, as objects (§3).
   *
   * An entry is a path, or a path with something said about it — so far only
   * that the file explorer should skip it. Normalised here so the editor deals
   * in one shape and the file keeps whichever form each entry was written in.
   */
  const openedContext = (): WorkspaceDir[] => {
    const f = draft();
    if (!f) return [];
    const legacy = f.directories ?? [];
    const inherited = f.cwd ? legacy : legacy.slice(1);
    return [...(f.context ?? []), ...inherited].map(asWorkspaceDir);
  };

  /** A directory as the file should hold it: a path, unless a flag needs saying. */
  const asRef = (dir: WorkspaceDir) => (dir.hidden ? { path: dir.path, hidden: true } : dir.path);

  /** Write the list back, plain strings except where a flag needs carrying. */
  const saveContext = (dirs: WorkspaceDir[]) => {
    patch({
      context: dirs.map(asRef),
      cwd: openedCwd() ? asRef(openedCwd()!) : undefined,
      directories: undefined,
    });
  };

  const saveCwd = (dir: WorkspaceDir | undefined) => {
    patch({
      cwd: dir ? asRef(dir) : undefined,
      context: openedContext().map(asRef),
      directories: undefined,
    });
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

  /** On a phone the index and the section are separate screens. */
  const showIndex = () => state.compact && atIndex();
  const showPanel = () => !showIndex();

  const open = (item: SectionItem) => {
    setSection(item.id);
    setAtIndex(false);
  };

  return (
    <Drawer open={state.settingsOpen} onOpenChange={setSettingsOpen} side={state.compact ? "bottom" : "right"}>
      <div data-slot="drawer-header">
        <Show
          when={state.compact && !atIndex()}
          fallback={<Icon name="settings" size={15} class="text-v2-icon-icon-muted" />}
        >
          <IconButton icon="chevron-left" label="Back to settings" variant="ghost-muted" onClick={() => setAtIndex(true)} />
        </Show>
        <span data-slot="drawer-title">
          {state.compact && !atIndex() ? (SECTION_LABEL.get(current()) ?? "Settings") : "Settings"}
        </span>
        <span class="flex-1" />
        <IconButton icon="close" label="Close settings" variant="ghost-muted" onClick={() => setSettingsOpen(false)} />
      </div>

      <Show when={error()}>
        {(message) => (
          <div data-slot="dialog-error" class="mx-3.5 mt-3" data-corvu-no-drag>
            <Icon name="alert" size={14} />
            <span class="whitespace-pre-wrap">{message()}</span>
          </div>
        )}
      </Show>

      {/*
        Everything below the header is a no-drag region (DESIGN §47).

        Corvu treats a drag anywhere on the drawer as a dismissal, and walks up
        from the touch point looking for `data-corvu-no-drag` — so the way to
        confine dragging to the header is to mark everything that is not the
        header. It has no scroll-aware exception worth relying on: a list that
        reaches its end, a row that is not scrollable, or a swipe that starts
        slightly off-axis all handed the gesture to the drawer, which then
        closed while someone was trying to read.
      */}
      <div data-slot="drawer-body" data-corvu-no-drag>
        {/* Wide screens: a permanent rail. */}
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
                      onClick={() => open(item)}
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

        {/* Phones: the same sections as a list you tap into. */}
        <Show when={showIndex()}>
          <div data-slot="settings-index">
            <For each={GROUPS}>
              {(group) => (
                <>
                  <div data-slot="settings-index-group">{group.title}</div>
                  <div data-slot="settings-index-card">
                    <For each={group.items}>
                      {(item) => (
                        <button
                          type="button"
                          data-slot="settings-index-item"
                          disabled={group.scope === "workspace" && !state.workspace}
                          onClick={() => open(item)}
                        >
                          <Icon name={item.icon} size={16} class="text-v2-icon-icon-muted" />
                          <span class="flex-1 text-start">{item.label}</span>
                          <Icon name="chevron-right" size={15} class="text-v2-text-text-faint" />
                        </button>
                      )}
                    </For>
                  </div>
                </>
              )}
            </For>
            <Show when={!state.workspace}>
              <p data-slot="field-hint" class="px-1">
                Workspace settings need a workspace open.
              </p>
            </Show>
          </div>
        </Show>

        <div data-slot="settings-panel" data-hidden={showPanel() ? undefined : ""}>
          <Show when={current() === "appearance"}>
            <AppearancePanel />
          </Show>
          <Show when={current() === "notifications"}>
            <NotificationsPanel />
          </Show>
          <Show when={current() === "app-memory"}>
            <GlobalMemoryPanel
              dirs={state.settings.memory}
              resolved={state.workspace?.memory ?? []}
              onChange={(memory) => void saveGlobalSettings({ ...unwrap(state.settings), memory })}
            />
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
                  <div class="flex flex-col gap-4">
                    {/*
                      One working directory, then everything open beside it
                      (§3). Editing either writes the new fields, which is also
                      how a workspace still on the old flat `directories` list
                      is migrated: the first save moves it across.
                    */}
                    <DirectoryListEditor
                      label="Working directory"
                      placeholder="/path/to/repo"
                      values={openedCwd() ? [openedCwd()!.path] : []}
                      max={1}
                      hint="Where the agent works by default."
                      shown={() => !openedCwd()?.hidden}
                      onToggleShown={(_value, show) => {
                        const dir = openedCwd();
                        if (dir) saveCwd({ path: dir.path, hidden: !show });
                      }}
                      onChange={(values) =>
                        saveCwd(values[0] === undefined ? undefined : { path: values[0], hidden: openedCwd()?.hidden })
                      }
                    />
                    <DirectoryListEditor
                      label="Context directories"
                      placeholder="/path/to/reference"
                      values={openedContext().map((dir) => dir.path)}
                      hint="Open alongside it, and writable. These may sit inside the working directory, or contain it. Switch off the eye to keep a directory reachable without listing it in the file explorer — which is how your home directory is opened."
                      shown={(value) => !openedContext().find((dir) => dir.path === value)?.hidden}
                      onToggleShown={(value, show) =>
                        saveContext(
                          openedContext().map((dir) => (dir.path === value ? { path: dir.path, hidden: !show } : dir)),
                        )
                      }
                      onChange={(values) =>
                        saveContext(
                          values.map((path) => openedContext().find((dir) => dir.path === path) ?? { path }),
                        )
                      }
                    />
                  </div>
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

                <Show when={current() === "memory"}>
                  <WorkspaceMemoryPanel
                    dirs={file().memory ?? {}}
                    resolved={state.workspace?.memory ?? []}
                    onChange={(memory) => patch({ memory })}
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

      {/*
        A status line, not a form. Workspace edits write themselves; this says
        where they went, because they go to a file that travels with the project
        and it should not be a surprise that one was touched.
      */}
      <Show when={showPanel() && !APP_SECTIONS.has(current())}>
        <div data-slot="drawer-footer" data-corvu-no-drag>
          <span class="text-v2-text-text-muted">
            {saving() || pending() ? "Saving…" : "Saved to workspace.json"}
          </span>
        </div>
      </Show>
    </Drawer>
  );
}

/**
 * A list of directories, each typeable or browsable (DESIGN §3).
 *
 * A path stays typeable because that is faster when you know it; the chooser is
 * what makes the field usable when you do not.
 */
function DirectoryListEditor(props: {
  label: string;
  values: string[];
  placeholder: string;
  /** A note under the heading, for lists whose purpose is not self-evident. */
  hint?: string;
  /** How many entries the list may hold. One, for the working directory. */
  max?: number;
  onChange: (values: string[]) => void;
  /** Whether a row appears in the file explorer. Omitted lists have no switch. */
  shown?: (value: string) => boolean;
  onToggleShown?: (value: string, shown: boolean) => void;
}) {
  const full = () => props.max !== undefined && props.values.length >= props.max;
  /** Which row the chooser is editing, or -1 for a new one. Null when closed. */
  const [browsing, setBrowsing] = createSignal<number | null>(null);
  return (
    <div class="flex flex-col gap-2">
      <div data-slot="section-title">{props.label}</div>
      <Show when={props.hint}>
        <p data-slot="field-hint">{props.hint}</p>
      </Show>
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
            <Show when={props.shown && props.onToggleShown}>
              <IconButton
                icon={props.shown!(value) ? "eye" : "eye-off"}
                label={props.shown!(value) ? "Hide from the file explorer" : "Show in the file explorer"}
                onClick={() => props.onToggleShown!(value, !props.shown!(value))}
              />
            </Show>
            <IconButton icon="folder" label={`Browse for ${props.label}`} onClick={() => setBrowsing(index())} />
            <IconButton
              icon="close"
              label="Remove"
              onClick={() => props.onChange(props.values.filter((_, i) => i !== index()))}
            />
          </div>
        )}
      </For>
      <Show when={!full()}>
        <Button variant="neutral" icon="folder" class="self-start" onClick={() => setBrowsing(-1)}>
          Add
        </Button>
      </Show>

      {/* `initialPath` is resolved: a workspace file stores paths relative to
          itself, and "." would otherwise start the browser wherever the server
          happens to be running. */}
      <Show when={browsing() !== null}>
        <DirectoryDialog
          open
          onOpenChange={(open) => !open && setBrowsing(null)}
          title={props.label}
          confirmLabel={browsing() === -1 ? "Add" : "Choose"}
          initialPath={
            browsing()! >= 0 ? resolveWorkspacePath(props.values[browsing()!] ?? "", state.workspace?.path) : undefined
          }
          onChoose={(folder) => {
            const at = browsing()!;
            props.onChange(at === -1 ? [...props.values, folder] : props.values.map((v, i) => (i === at ? folder : v)));
            setBrowsing(null);
          }}
        />
      </Show>
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
