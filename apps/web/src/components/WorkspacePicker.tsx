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
 * One path field drives everything, and the listing below it is the completion
 * surface. It always shows a real folder — the deepest one on the typed path
 * that exists — filtered by whatever is being typed after the last separator,
 * and falling back to the whole folder when that matches nothing, so the panel
 * never goes blank at the moment a name is being invented.
 *
 * Tab accepts the highlighted candidate: into a folder, or a filename filled in
 * whole. Pressing it again walks the list. Shift+Tab is the way back out. Click
 * a folder to descend, a workspace file to open it, and Create either makes a
 * workspace in the folder on screen or writes the filename that was typed.
 */
export function WorkspacePicker() {
  const [path, setPath] = createSignal("");
  const [entries, setEntries] = createSignal<PathCompletion[]>([]);
  const [base, setBase] = createSignal("");
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
          setBase(completed.value.base);
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

  /**
   * A workspace filename typed out in full, for a file that is not there yet.
   * Only names Picone would recognise count, so half-typed prefixes stay
   * completions rather than turning into an offer to create something.
   */
  const newWorkspaceFile = () => {
    const current = info();
    if (!current || current.exists || missing()) return null;
    const name = path().split(/[/\\]/).pop() ?? "";
    const known = /\.workspace\.json$/i.test(name) || /^(workspace|picone)\.json$/i.test(name);
    return known ? current.path : null;
  };

  /** What Create would make, as a path, or null when it can make nothing. */
  const createTarget = () => newWorkspaceFile() ?? targetDirectory();

  const withTrailing = (value: string) => (/[/\\]$/.test(value) ? value : value + separator());

  const activate = (entry: PathCompletion) => {
    resetCycle();
    if (entry.type === "file") {
      if (entry.workspace) void open(entry.path);
      return;
    }
    setPath(withTrailing(entry.path));
    input?.focus();
  };

  /**
   * Tab, and the button that stands in for it where there is no keyboard.
   *
   * It accepts whatever is highlighted: a folder becomes the new location and
   * the listing follows it in, a file is filled in whole. Pressing it again
   * moves to the next candidate, walking the list the way completion does
   * everywhere else.
   *
   * The candidates are captured on the first press, because filling one in
   * narrows the field's own filter down to it — cycling has to remember what
   * was on offer before that happened. Typing anything starts over.
   */
  let cycle: { items: PathCompletion[]; at: number } | null = null;
  const resetCycle = () => {
    cycle = null;
  };

  const complete = () => {
    if (cycle) {
      cycle.at = (cycle.at + 1) % cycle.items.length;
    } else {
      const items = entries();
      if (items.length === 0) return;
      cycle = { items, at: Math.min(index(), items.length - 1) };
    }

    const entry = cycle.items[cycle.at]!;
    setPath(entry.type === "file" ? entry.path : withTrailing(entry.path));
    // Stepping into a folder is a fresh set of candidates, not a continuation.
    if (entry.type !== "file") resetCycle();
    input?.focus();
  };

  /** An empty parent is the roots listing, which an empty path is how you ask for. */
  const goUp = () => {
    resetCycle();
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
    const file = newWorkspaceFile();
    const directory = targetDirectory();
    if (!file && !directory) return;
    setBusy(true);
    setError(null);
    try {
      await createWorkspace(file ? { directory: "", file } : { directory: directory!, location: "inside" });
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
      event.preventDefault();
      // Shift+Tab is the way back out, so completing forward is never a
      // one-way trip into the first child of every folder.
      if (event.shiftKey) goUp();
      else complete();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // An existing file opens, a new workspace name is created, and only then
      // does Enter fall through to completing against the highlighted row.
      if (info()?.type === "file") {
        void open(info()!.path);
        return;
      }
      if (newWorkspaceFile()) {
        void create();
        return;
      }
      const entry = items[index()];
      if (entry && filtering()) activate(entry);
    }
  };

  const canCreate = () => createTarget() !== null && !busy();
  const filtering = () => path().trim() !== "" && !/[/\\]$/.test(path());

  return (
    <Dialog
      open={state.workspacePickerOpen}
      onOpenChange={setWorkspacePickerOpen}
      title="Open workspace"
      description="Pick a folder to work in, or a workspace file to reopen. Tab completes."
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
              onInput={(event) => {
                resetCycle();
                setPath(event.currentTarget.value);
              }}
              onKeyDown={onKeyDown}
            />
            <Show when={path()}>
              <button
                type="button"
                data-slot="path-clear"
                aria-label="Clear"
                onClick={() => {
                  resetCycle();
                  setPath("");
                  input?.focus();
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </Show>

            {/* Touch devices have no Tab key, and completion is too useful to
                leave to the ones that do. Hidden by a media query rather than a
                condition here: it is the same responsive decision the rest of
                the layout makes in CSS. */}
            <button
              type="button"
              data-slot="path-tab"
              aria-label="Complete"
              disabled={entries().length === 0}
              onClick={complete}
            >
              Tab
            </button>
          </div>

          <Button
            variant="contrast"
            icon="plus"
            disabled={!canCreate()}
            title={
              newWorkspaceFile()
                ? `Create ${newWorkspaceFile()}`
                : targetDirectory()
                  ? `Create a workspace in ${targetDirectory()}`
                  : "Navigate to a folder, or type a workspace filename"
            }
            onClick={() => void create()}
          >
            Create
          </Button>
        </div>

        {/* The listing is of a folder, not of the text in the field, and those
            two part company the moment a name is half-typed. Say which. */}
        <Show when={base()}>
          <div data-slot="picker-base" title={base()}>
            {base()}
          </div>
        </Show>

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
              No such folder. Showing the nearest one above.
            </div>
          </Show>

          {/* The listing below is the folder this name would go in, so say what
              Create would do rather than leaving the rows to imply it. */}
          <Show when={newWorkspaceFile()}>
            <div data-slot="path-empty">
              <Icon name="plus" size={13} />
              Create {path().split(/[/\\]/).pop()} here
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
