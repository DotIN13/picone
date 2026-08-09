import { For, Show, createSignal } from "solid-js";
import type { MemoryDirs, ResolvedMemoryDir } from "@picone/protocol";
import { MemoryDirDialog } from "./MemoryDirDialog.tsx";
import { Button, IconButton } from "./ui/button.tsx";
import { Switch, Tag, TextInput } from "./ui/primitives.tsx";

/**
 * Memory directories (DESIGN §50), in both halves of the settings drawer.
 *
 * The global panel owns the paths; the workspace panel switches them on and off
 * and adds its own. Both edit the same `MemoryDirs` record, which is why they
 * are one file — the difference is what the rows may change, not their shape.
 */

/** What the server worked out about a directory, when it knows anything. */
function Facts(props: { resolved?: ResolvedMemoryDir }) {
  return (
    <Show when={props.resolved}>
      {(dir) => (
        <span data-slot="memory-facts">
          <Show when={!dir().exists} fallback={<>{dir().entries} entries</>}>
            <span class="text-v2-state-fg-danger">not found</span>
          </Show>
          <Show when={dir().exists && dir().hasInstructions}> · describes itself</Show>
          <Show when={dir().exists && dir().hasIndex}> · has a catalog</Show>
        </span>
      )}
    </Show>
  );
}

/**
 * The global list: the only place a path is typed. Backed by the server rather
 * than by `localStorage`, because a path is a fact about the machine.
 */
export function GlobalMemoryPanel(props: {
  dirs: MemoryDirs;
  resolved: ResolvedMemoryDir[];
  onChange: (dirs: MemoryDirs) => void;
}) {
  const [adding, setAdding] = createSignal(false);
  const resolvedFor = (name: string) => props.resolved.find((dir) => dir.name === name);
  const patch = (name: string, change: Partial<MemoryDirs[string]>) =>
    props.onChange({ ...props.dirs, [name]: { ...props.dirs[name], ...change } });

  const remove = (name: string) => {
    const next = { ...props.dirs };
    delete next[name];
    props.onChange(next);
  };

  return (
    <div class="flex flex-col gap-3">
      <div data-slot="section-title">Memory</div>
      <p data-slot="field-hint">Folders of long-lived notes, offered to every workspace.</p>

      <Show
        when={Object.keys(props.dirs).length > 0}
        fallback={<div data-slot="field-hint">No memory directories yet.</div>}
      >
        <For each={Object.entries(props.dirs)}>
          {([name, dir]) => (
            <div data-slot="memory-card">
              <div class="flex items-center gap-2">
                <strong>{name}</strong>
                <Facts resolved={resolvedFor(name)} />
                <span class="flex-1" />
                <IconButton icon="close" label={`Remove ${name}`} onClick={() => remove(name)} />
              </div>
              <TextInput
                value={dir.path ?? ""}
                placeholder="/path/to/notes"
                onValue={(path) => patch(name, { path })}
              />
              <Switch
                checked={dir.writable === true}
                onChange={(writable) => patch(name, { writable })}
                label="Let the agent write here"
              />
            </div>
          )}
        </For>
      </Show>

      <div>
        <Button variant="neutral" icon="plus" onClick={() => setAdding(true)}>
          Add a directory
        </Button>
      </div>

      <MemoryDirDialog
        open={adding()}
        onOpenChange={setAdding}
        existing={Object.keys(props.dirs)}
        offerWritable
        onAdd={({ name, path, writable }) =>
          props.onChange({ ...props.dirs, [name]: { path, writable: writable || undefined } })
        }
      />
    </div>
  );
}

/**
 * The workspace list: switches over everything inherited, plus directories of
 * this workspace's own. Writing to the file only ever records a decision, so a
 * global entry keeps its path even while switched off here.
 */
export function WorkspaceMemoryPanel(props: {
  dirs: MemoryDirs;
  resolved: ResolvedMemoryDir[];
  onChange: (dirs: MemoryDirs | undefined) => void;
}) {
  const [adding, setAdding] = createSignal(false);

  const patch = (name: string, change: Partial<MemoryDirs[string]>) => {
    const next: MemoryDirs = { ...props.dirs, [name]: { ...props.dirs[name], ...change } };
    props.onChange(next);
  };

  const remove = (name: string) => {
    const next = { ...props.dirs };
    delete next[name];
    props.onChange(Object.keys(next).length > 0 ? next : undefined);
  };

  return (
    <div class="flex flex-col gap-3">
      <div data-slot="section-title">Memory</div>
      <p data-slot="field-hint">Directories added here belong to this workspace alone.</p>

      <Show
        when={props.resolved.length > 0}
        fallback={<div data-slot="field-hint">No memory directories are available. Add one in App settings.</div>}
      >
        <For each={props.resolved}>
          {(dir) => (
            <div data-slot="resource-row">
              <Switch
                checked={dir.enabled}
                onChange={(enabled) => patch(dir.name, { enabled })}
                label={dir.name}
              />
              <Tag tone={dir.writable ? "info" : "neutral"}>{dir.writable ? "writable" : "read-only"}</Tag>
              <Show when={dir.source === "workspace"}>
                <Tag>this workspace</Tag>
              </Show>
              <Show when={!dir.exists}>
                <Tag tone="danger">missing</Tag>
              </Show>
              <span class="flex-1" />
              <span data-slot="resource-path" title={dir.path}>
                {dir.path}
              </span>
              <Show when={dir.source === "workspace"}>
                <IconButton icon="close" label={`Remove ${dir.name}`} onClick={() => remove(dir.name)} />
              </Show>
            </div>
          )}
        </For>
      </Show>

      <div>
        <Button variant="neutral" icon="plus" onClick={() => setAdding(true)}>
          Add a directory
        </Button>
      </div>

      <MemoryDirDialog
        open={adding()}
        onOpenChange={setAdding}
        existing={props.resolved.map((dir) => dir.name)}
        onAdd={({ name, path }) => props.onChange({ ...props.dirs, [name]: { path } })}
      />

      <p class="text-v2-text-text-muted">Takes effect in sessions started after saving.</p>
    </div>
  );
}
