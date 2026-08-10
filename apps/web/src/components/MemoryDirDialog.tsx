import { Show, createSignal } from "solid-js";
import { DirectoryDialog } from "./DirectoryDialog.tsx";
import { Switch, TextInput } from "./ui/primitives.tsx";

/**
 * Choose a folder to remember from (DESIGN §50).
 *
 * Adding a memory directory is the same act as choosing any other directory —
 * find a folder — so it is the shared chooser with a different ending. What is
 * left here is only that ending: the name the directory will be known by, and
 * whether the agent may write to it.
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
  const [name, setName] = createSignal("");
  const [writable, setWritable] = createSignal(false);
  /** The folder the browser is on, so a name can be suggested before committing. */
  const [folder, setFolder] = createSignal<string | null>(null);

  const suggested = () => (folder() ?? "").split(/[/\\]/).pop() ?? "";
  const finalName = () => (name().trim() || suggested()).trim();
  const taken = () => finalName() !== "" && props.existing.includes(finalName());

  return (
    <DirectoryDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          setName("");
          setWritable(false);
        }
        props.onOpenChange(open);
      }}
      title="Add memory directory"
      confirmLabel="Add"
      canConfirm={() => finalName() !== "" && !taken()}
      onChoose={(path) => {
        props.onAdd({ name: finalName(), path, writable: writable() });
        setName("");
        setWritable(false);
      }}
      // The chooser owns the browsing; this owns the naming, and reads the
      // folder from it to suggest one.
      onFolder={setFolder}
      extra={
        <>
          <TextInput label="Name" value={name()} placeholder={suggested() || "name"} onValue={setName} />
          <Show when={taken()}>
            <div data-slot="field-hint" class="text-v2-state-fg-danger">
              A memory directory called “{finalName()}” already exists.
            </div>
          </Show>
          <Show when={props.offerWritable}>
            <Switch checked={writable()} onChange={setWritable} label="Let the agent write here" />
          </Show>
        </>
      }
    />
  );
}
