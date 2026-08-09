import { Show, createSignal } from "solid-js";
import { PathBrowser, type PathState } from "./PathBrowser.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, Switch, TextInput } from "./ui/primitives.tsx";

/**
 * Choose a folder to remember from (DESIGN §50).
 *
 * Adding a memory directory is the same act as opening a workspace — find a
 * folder — so it is the same browser, with a different ending. Typing a raw
 * path into a settings field asked the user to be their own file manager.
 */
export function MemoryDirDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names already taken; a second `notes` would silently replace the first. */
  existing: string[];
  /** The workspace panel offers a name only; the app panel offers writability too. */
  offerWritable?: boolean;
  onAdd: (entry: { name: string; path: string; writable: boolean }) => void;
}) {
  const [path, setPath] = createSignal("");
  const [resolved, setResolved] = createSignal<PathState>({ base: "", missing: false, info: null });
  const [name, setName] = createSignal("");
  const [writable, setWritable] = createSignal(false);

  /**
   * The folder in view, which is what "add this one" means.
   *
   * Trailing separators are significant while browsing — they are what asks for
   * a listing rather than a prefix match — so `inspectPath` keeps them. They
   * have no business in a config file, so they are dropped here.
   */
  const folder = () => {
    const info = resolved().info;
    if (info?.type !== "directory") return null;
    return info.path.replace(/[/\\]+$/, "") || info.path;
  };

  const suggested = () => (folder() ?? "").replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  const finalName = () => (name().trim() || suggested()).trim();
  const taken = () => finalName() !== "" && props.existing.includes(finalName());
  const valid = () => folder() !== null && finalName() !== "" && !taken();

  const reset = () => {
    setPath("");
    setName("");
    setWritable(false);
    setResolved({ base: "", missing: false, info: null });
  };

  const submit = () => {
    if (!valid()) return;
    props.onAdd({ name: finalName(), path: folder()!, writable: writable() });
    reset();
    props.onOpenChange(false);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) reset();
        props.onOpenChange(open);
      }}
      title="Add memory directory"
      description="Tab completes."
      width="620px"
      footer={
        <>
          <span data-slot="memory-dialog-target" title={folder() ?? undefined}>
            <Show when={folder()} fallback="No folder selected">
              {(dir) => dir().replace(/[/\\]+$/, "") || dir()}
            </Show>
          </span>
          <span class="flex-1" />
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="contrast" icon="plus" disabled={!valid()} onClick={submit}>
            Add
          </Button>
        </>
      }
    >
      <div data-slot="picker-body">
        <PathBrowser
          path={path()}
          onPathChange={setPath}
          onState={setResolved}
          placeholder="Type a path, or pick below"
          // Only folders are memory. Files are shown so you can tell where you
          // are — an AGENTS.md in the listing is exactly the reassurance you
          // want before adding the folder that holds it.
          onSubmit={valid() ? submit : undefined}
        />

        <div data-slot="memory-dialog-form">
          <TextInput
            label="Name"
            value={name()}
            placeholder={suggested() || "name"}
            onValue={setName}
          />
          <Show when={taken()}>
            <div data-slot="field-hint" class="text-v2-state-fg-danger">
              A memory directory called “{finalName()}” already exists.
            </div>
          </Show>
          <Show when={props.offerWritable}>
            <Switch checked={writable()} onChange={setWritable} label="Let the agent write here" />
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
