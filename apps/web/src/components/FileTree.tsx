import { For, Show } from "solid-js";
import type { DirEntry, GitStatus } from "@picone/protocol";
import { openFile, state, toggleDirectory, treeKey } from "../store.ts";
import { Icon } from "./ui/icon.tsx";

const STATUS_MARK: Record<GitStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "U",
  renamed: "R",
  conflicted: "!",
};

/** Working directory, then context, then memory (DESIGN §3, §50). */
const ORDER: Record<string, number> = { cwd: 0, context: 1, memory: 2 };

export function FileTree() {
  /*
   * The cwd is first because it is where the projects are, and burying it among
   * reference and memory directories is what made them hard to find. Sorted
   * here rather than trusted from the server: this is the order the reader
   * sees, so it is stated where the reading happens.
   *
   * A stable sort, so directories keep the order the workspace file lists them
   * in within each group.
   */
  const roots = () =>
    [...(state.workspace?.roots ?? [])].sort((a, b) => (ORDER[a.kind] ?? 1) - (ORDER[b.kind] ?? 1));

  return (
    <div class="py-0.5">
      <For each={roots()}>
        {(root) => (
          <TreeNode
            entry={{ name: root.name, path: root.path, type: "directory" }}
            depth={0}
            missing={!root.exists}
            isRoot
            kind={root.kind}
            root={root.path}
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
  /** Only set on roots; children are just files. */
  kind?: "cwd" | "context" | "memory";
  /**
   * The root this row is being shown under, carried down the tree.
   *
   * Open/closed belongs to the row, not the directory: a context directory
   * inside the working directory appears twice, and opening one should not
   * open the other (§12).
   */
  root: string;
}) {
  const key = () => treeKey(props.root, props.entry.path);
  const expanded = () => state.expanded[key()] ?? false;
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
        onClick={() =>
          isDir() ? void toggleDirectory(key(), props.entry.path) : void openFile(props.entry.path)
        }
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
        {/*
          What this root is. Worth saying for two of the three: a context
          directory may also appear further down inside the working directory
          (§3), and seeing the same folder twice with no explanation reads as a
          bug. The working directory needs no label — it is the first row, and
          everything else is named relative to it.
        */}
        <Show when={props.kind === "context" || props.kind === "memory"}>
          <span data-slot="tree-tag" data-kind={props.kind}>{props.kind}</span>
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
        <For each={children()}>
          {(child) => <TreeNode entry={child} depth={props.depth + 1} root={props.root} />}
        </For>
        <Show when={children()?.length === 0}>
          <div data-slot="tree-row" data-muted="" style={{ "padding-inline-start": `${(props.depth + 1) * 12 + 8}px` }}>
            empty
          </div>
        </Show>
      </Show>
    </Show>
  );
}
