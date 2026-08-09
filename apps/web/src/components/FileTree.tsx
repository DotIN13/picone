import { For, Show } from "solid-js";
import type { DirEntry, GitStatus } from "@picone/protocol";
import { openFile, state, toggleDirectory } from "../store.ts";
import { Icon } from "./ui/icon.tsx";

const STATUS_MARK: Record<GitStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "U",
  renamed: "R",
  conflicted: "!",
};

export function FileTree() {
  // Project directories first, then memory (§50) — the same order the tree is
  // handed in, but stated here so it does not depend on how roots were built.
  const roots = () =>
    [...(state.workspace?.roots ?? [])].sort((a, b) => Number(a.kind === "memory") - Number(b.kind === "memory"));

  return (
    <div class="py-0.5">
      <For each={roots()}>
        {(root) => (
          <TreeNode
            entry={{ name: root.name, path: root.path, type: "directory" }}
            depth={0}
            missing={!root.exists}
            isRoot
            memory={root.kind === "memory"}
          />
        )}
      </For>
    </div>
  );
}

function TreeNode(props: {
  entry: DirEntry;
  depth: number;
  missing?: boolean;
  isRoot?: boolean;
  memory?: boolean;
}) {
  const expanded = () => state.expanded[props.entry.path] ?? false;
  const children = () => state.tree[props.entry.path];
  const loading = () => state.treeLoading[props.entry.path] ?? false;
  const status = () => state.gitStatus[props.entry.path];
  const isDir = () => props.entry.type === "directory";
  const indent = () => `${props.depth * 12 + 8}px`;

  return (
    <Show
      when={!props.missing}
      fallback={
        <div data-slot="tree-row" data-missing="" style={{ "padding-inline-start": indent() }}>
          <Icon name="alert" size={13} class="shrink-0" />
          <span class="truncate">{props.entry.name}</span>
          <span class="ml-auto text-[calc(10px*var(--font-scale))] uppercase tracking-wide">missing</span>
        </div>
      }
    >
      <button
        type="button"
        data-slot="tree-row"
        data-root={props.isRoot ? "" : undefined}
        data-selected={state.activeTabId === props.entry.path ? "" : undefined}
        style={{ "padding-inline-start": indent() }}
        title={props.entry.path}
        onClick={() => (isDir() ? void toggleDirectory(props.entry.path) : void openFile(props.entry.path))}
      >
        <span data-slot="tree-twisty">
          <Show when={isDir()}>
            <Icon name={expanded() ? "chevron-down" : "chevron-right"} size={12} />
          </Show>
        </span>
        <Show when={isDir()} fallback={<Icon name="file" size={13} class="shrink-0 text-v2-icon-icon-muted" />}>
          <Icon name="folder" size={13} class="shrink-0 text-v2-icon-icon-muted" />
        </Show>
        <span class="truncate">{props.entry.name}</span>
        {/* Says what this root is, since it is not project code (§50). */}
        <Show when={props.memory}>
          <span data-slot="tree-tag">memory</span>
        </Show>
        <Show when={status()}>
          {(mark) => (
            <span data-slot="git-mark" data-status={mark()}>
              {STATUS_MARK[mark()]}
            </span>
          )}
        </Show>
      </button>

      <Show when={isDir() && expanded()}>
        <Show when={loading() && !children()}>
          <div data-slot="tree-row" data-muted="" style={{ "padding-inline-start": `${(props.depth + 1) * 12 + 8}px` }}>
            loading…
          </div>
        </Show>
        <For each={children()}>{(child) => <TreeNode entry={child} depth={props.depth + 1} />}</For>
        <Show when={children()?.length === 0}>
          <div data-slot="tree-row" data-muted="" style={{ "padding-inline-start": `${(props.depth + 1) * 12 + 8}px` }}>
            empty
          </div>
        </Show>
      </Show>
    </Show>
  );
}
