import { Show, createEffect, createSignal, type JSX } from "solid-js";
import { PathBrowser, type PathState } from "./PathBrowser.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog } from "./ui/primitives.tsx";

/**
 * Choose a folder (DESIGN §3).
 *
 * Every place Picone asks for a directory asks the same question, and the
 * answer used to be typed by hand in two of them — a settings field with a raw
 * path in it asks the user to be their own file manager. So the browser, the
 * "which folder am I on" line, and the confirm button are one component, and
 * what differs between callers is only the ending: memory adds a name and a
 * writable switch, the workspace directory fields add nothing at all.
 *
 * `PathBrowser` remains the piece underneath — the workspace picker uses it
 * directly, because picking a workspace *file* is a different question with a
 * different answer, and wrapping it in a folder chooser would fit neither.
 */
export function DirectoryDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** The button that commits. "Add" when appending to a list, "Choose" when replacing. */
  confirmLabel?: string;
  /** Where to start. A field being edited passes its current value. */
  initialPath?: string;
  /** The caller's own fields, under the browser. */
  extra?: JSX.Element;
  /**
   * The folder in view, as it changes. Callers that derive something from it —
   * memory suggests a name from the folder's basename — read it here rather
   * than during render, which in Solid would be a write inside a computation.
   */
  onFolder?: (folder: string | null) => void;
  /** Extra conditions beyond "a folder is selected" — a name not already taken. */
  canConfirm?: () => boolean;
  onChoose: (folder: string) => void;
}) {
  const [path, setPath] = createSignal(props.initialPath ?? "");
  const [resolved, setResolved] = createSignal<PathState>({ base: "", missing: false, info: null });

  /**
   * The folder in view, which is what "choose this one" means.
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

  createEffect(() => props.onFolder?.(folder()));

  const valid = () => folder() !== null && (props.canConfirm?.() ?? true);

  const reset = () => {
    setPath(props.initialPath ?? "");
    setResolved({ base: "", missing: false, info: null });
  };

  const submit = () => {
    if (!valid()) return;
    props.onChoose(folder()!);
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
      title={props.title}
      description="Tab completes."
      width="620px"
      footer={
        <>
          {/* The folder that will be committed, spelled out — the listing shows
              where you are browsing, which is not always the same thing. */}
          <span data-slot="picker-target" title={folder() ?? undefined}>
            <Show when={folder()} fallback="No folder selected">
              {(dir) => dir()}
            </Show>
          </span>
          <span class="flex-1" />
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="contrast" icon="plus" disabled={!valid()} onClick={submit}>
            {props.confirmLabel ?? "Choose"}
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
          // Files are listed but not selectable: seeing an AGENTS.md in the
          // folder is exactly the reassurance you want before choosing it.
          onSubmit={valid() ? submit : undefined}
        />

        <Show when={props.extra}>
          <div data-slot="picker-form">{props.extra}</div>
        </Show>
      </div>
    </Dialog>
  );
}
