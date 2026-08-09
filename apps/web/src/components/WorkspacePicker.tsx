import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import type { PathCompletion, PathInspectResponse, RecentWorkspace } from "@picone/protocol";
import { api } from "../lib/api.ts";
import { createWorkspace, openWorkspace, setWorkspacePickerOpen, state } from "../store.ts";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Dialog } from "./ui/primitives.tsx";

/**
 * Open or create a workspace (DESIGN §3).
 *
 * One path field drives everything. The listing below it is the completion
 * surface: it always shows what is at the typed path, filtering as you type.
 * Click a folder to descend, a workspace file to open it, or Create to make a
 * workspace for the folder you are looking at.
 */
export function WorkspacePicker() {
  const [path, setPath] = createSignal("");
  const [entries, setEntries] = createSignal<PathCompletion[]>([]);
  const [separator, setSeparator] = createSignal<"/" | "\\">("/");
  const [missing, setMissing] = createSignal(false);
  const [info, setInfo] = createSignal<PathInspectResponse | null>(null);
  const [recent, setRecent] = createSignal<RecentWorkspace[]>([]);
  const [index, setIndex] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  let input: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;
  let timer: number | undefined;
  /** Guards against a slow response overwriting a newer one. */
  let generation = 0;

  onMount(() => void api.recentWorkspaces().then(({ workspaces }) => setRecent(workspaces)));
  onCleanup(() => {
    if (timer) window.clearTimeout(timer);
  });

  createEffect(
    on(path, (value) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const mine = ++generation;
        const [completed, inspected] = await Promise.allSettled([api.completePath(value), api.inspectPath(value)]);
        if (mine !== generation) return;

        if (completed.status === "fulfilled") {
          setEntries(completed.value.completions);
          setSeparator(completed.value.separator);
          setMissing(completed.value.missing && value.trim() !== "");
          setIndex(0);
        }
        setInfo(inspected.status === "fulfilled" ? inspected.value : null);
      }, 110);
    }),
  );

  createEffect(() => {
    const i = index();
    list?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" });
  });

  /** Where Create will put the workspace: the folder currently being viewed. */
  const targetDirectory = () => {
    const current = info();
    if (current?.type === "directory") return current.path;
    // Mid-typing a name inside a folder — the folder is still the target.
    return null;
  };

  const withTrailing = (value: string) => (/[/\\]$/.test(value) ? value : value + separator());

  const activate = (entry: PathCompletion) => {
    if (entry.type === "file") {
      if (entry.workspace) void open(entry.path);
      return;
    }
    setPath(withTrailing(entry.path));
    input?.focus();
  };

  /** An empty parent is the roots listing, which an empty path is how you ask for. */
  const goUp = () => {
    const parent = info()?.parent;
    if (parent === null || parent === undefined) return;
    setPath(parent === "" ? "" : withTrailing(parent));
    input?.focus();
  };

  const open = async (target: string) => {
    setBusy(true);
    setError(null);
    try {
      await openWorkspace(target);
      setWorkspacePickerOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const directory = targetDirectory();
    if (!directory) return;
    setBusy(true);
    setError(null);
    try {
      await createWorkspace({ directory, location: "inside" });
      setWorkspacePickerOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const items = entries();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (items.length) setIndex((i) => (i + 1) % items.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length) setIndex((i) => (i - 1 + items.length) % items.length);
      return;
    }
    if (event.key === "Tab") {
      const entry = items[index()];
      if (entry) {
        event.preventDefault();
        setPath(entry.type === "file" ? entry.path : withTrailing(entry.path));
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = items[index()];
      if (entry && path().trim() !== "" && !/[/\\]$/.test(path())) {
        activate(entry);
        return;
      }
      if (info()?.type === "file") void open(info()!.path);
    }
  };

  const canCreate = () => targetDirectory() !== null && !busy();
  const filtering = () => path().trim() !== "" && !/[/\\]$/.test(path());

  return (
    <Dialog
      open={state.workspacePickerOpen}
      onOpenChange={setWorkspacePickerOpen}
      title="Open workspace"
      description="Pick a folder to work in, or a workspace file to reopen."
      width="620px"
    >
      <div data-slot="picker-body">
        <Show when={error()}>
          {(message) => (
            <div data-slot="dialog-error">
              <Icon name="alert" size={14} />
              <span class="whitespace-pre-wrap">{message()}</span>
            </div>
          )}
        </Show>

        <div data-slot="picker-bar">
          <div data-slot="path-field">
            <Icon name="folder" size={14} class="shrink-0 text-v2-icon-icon-muted" />
            <input
              ref={input}
              type="text"
              spellcheck={false}
              autocapitalize="off"
              autocorrect="off"
              autocomplete="off"
              autofocus
              placeholder="Type a path, or pick below"
              value={path()}
              onInput={(event) => setPath(event.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            <Show when={path()}>
              <button
                type="button"
                data-slot="path-clear"
                aria-label="Clear"
                onClick={() => {
                  setPath("");
                  input?.focus();
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </Show>
          </div>

          <Button
            variant="contrast"
            icon="plus"
            disabled={!canCreate()}
            title={canCreate() ? `Create a workspace in ${targetDirectory()}` : "Navigate to a folder first"}
            onClick={() => void create()}
          >
            Create
          </Button>
        </div>

        <div data-slot="picker-list" ref={list} role="listbox">
          {/* Only meaningful once we are actually inside a folder. `parent` is
              "" at a drive root, which still has the drive list above it. */}
          <Show when={info()?.type === "directory" && info()?.parent !== null && info()?.parent !== undefined && !filtering()}>
            <button type="button" data-slot="path-item" onClick={goUp}>
              <Icon name="chevron-up" size={13} class="shrink-0 text-v2-icon-icon-muted" />
              <span class="truncate">..</span>
            </button>
          </Show>

          <Show when={missing()}>
            <div data-slot="path-empty">
              <Icon name="alert" size={13} />
              No such folder
            </div>
          </Show>

          <For each={entries()}>
            {(entry, i) => {
              // Other files are listed for orientation only — clicking
              // package.json and getting a validation error would be a lie.
              const actionable = entry.type !== "file" || Boolean(entry.workspace);
              return (
                <button
                  type="button"
                  role="option"
                  data-slot="path-item"
                  data-index={i()}
                  data-active={index() === i() ? "" : undefined}
                  data-inert={actionable ? undefined : ""}
                  aria-selected={index() === i()}
                  disabled={!actionable}
                  onMouseEnter={() => setIndex(i())}
                  onClick={() => activate(entry)}
                >
                  <Icon
                    name={entry.workspace ? "sparkle" : entry.type === "file" ? "file" : "folder"}
                    size={13}
                    classList={{
                      "shrink-0": true,
                      "text-v2-icon-icon-accent": Boolean(entry.workspace),
                      "text-v2-icon-icon-muted": !entry.workspace,
                    }}
                  />
                  <span class="truncate">{entry.name}</span>
                  {/* A drive is somewhere you can go, so it says so too. */}
                  <Show when={entry.type !== "file"}>
                    <Icon name="chevron-right" size={12} class="ml-auto shrink-0 opacity-40" />
                  </Show>
                </button>
              );
            }}
          </For>

          <Show when={entries().length === 0 && !missing()}>
            <div data-slot="path-empty">Nothing here</div>
          </Show>
        </div>

        {/* Recents stay out of the way while browsing, and reappear when idle. */}
        <Show when={recent().length > 0 && !filtering()}>
          <div data-slot="picker-recents">
            <div data-slot="section-title">Recent</div>
            <For each={recent().slice(0, 4)}>
              {(item) => (
                <button type="button" data-slot="picker-recent" disabled={busy()} onClick={() => void open(item.path)}>
                  <Icon name="sparkle" size={13} class="shrink-0 text-v2-icon-icon-accent" />
                  <span class="font-[530]">{item.name}</span>
                  <span data-slot="picker-recent-path">{item.path}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Dialog>
  );
}
