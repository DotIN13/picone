import { For, Show, createSignal, onMount } from "solid-js";
import type { PathCompletion, RecentWorkspace } from "@picone/protocol";
import { api } from "../lib/api.ts";
import { createWorkspace, openWorkspace, setWorkspacePickerOpen, state } from "../store.ts";
import { PathBrowser, type PathState } from "./PathBrowser.tsx";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Dialog } from "./ui/primitives.tsx";

/**
 * Open or create a workspace (DESIGN §3).
 *
 * The browsing is `PathBrowser`; what is left here is what a *workspace* picker
 * adds to it — recents, workspace files being the only clickable files, and a
 * Create that either makes a workspace in the folder on screen or writes the
 * filename that was typed.
 */
export function WorkspacePicker() {
  const [path, setPath] = createSignal("");
  const [resolved, setResolved] = createSignal<PathState>({ base: "", missing: false, info: null });
  const [recent, setRecent] = createSignal<RecentWorkspace[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  onMount(() => void api.recentWorkspaces().then(({ workspaces }) => setRecent(workspaces)));

  /** Where Create will put the workspace: the folder currently being viewed. */
  const targetDirectory = () => {
    const info = resolved().info;
    // Mid-typing a name inside a folder — the folder is still the target.
    return info?.type === "directory" ? info.path : null;
  };

  /**
   * A workspace filename typed out in full, for a file that is not there yet.
   * Only names Picone would recognise count, so half-typed prefixes stay
   * completions rather than turning into an offer to create something.
   */
  const newWorkspaceFile = () => {
    const { info, missing } = resolved();
    if (!info || info.exists || missing) return null;
    const name = path().split(/[/\\]/).pop() ?? "";
    const known = /\.workspace\.json$/i.test(name) || /^(workspace|picone)\.json$/i.test(name);
    return known ? info.path : null;
  };

  const createTarget = () => newWorkspaceFile() ?? targetDirectory();
  const canCreate = () => createTarget() !== null && !busy();
  const filtering = () => path().trim() !== "" && !/[/\\]$/.test(path());

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

  /** Enter: open what was typed, create what was named, else follow the highlight. */
  const onSubmit = () => {
    const info = resolved().info;
    if (info?.type === "file") {
      void open(info.path);
      return;
    }
    if (newWorkspaceFile()) void create();
  };

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

        <PathBrowser
          path={path()}
          onPathChange={setPath}
          onState={setResolved}
          // Other files are listed for orientation only — clicking package.json
          // and getting a validation error would be a lie.
          fileActionable={(entry: PathCompletion) => Boolean(entry.workspace)}
          onActivateFile={(entry) => void open(entry.path)}
          onSubmit={
            // Only claim Enter when there is something to claim it for;
            // otherwise the browser follows its own highlight.
            resolved().info?.type === "file" || newWorkspaceFile() ? onSubmit : undefined
          }
          trailing={
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
          }
        >
          {/* The listing below is the folder this name would go in, so say what
              Create would do rather than leaving the rows to imply it. */}
          <Show when={newWorkspaceFile()}>
            <div data-slot="path-empty">
              <Icon name="plus" size={13} />
              Create {path().split(/[/\\]/).pop()} here
            </div>
          </Show>
        </PathBrowser>

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
