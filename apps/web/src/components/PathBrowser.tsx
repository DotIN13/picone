import { For, Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js";
import type { PathCompletion, PathInspectResponse } from "@picone/protocol";
import { api } from "../lib/api.ts";
import { Icon } from "./ui/icon.tsx";

/**
 * A path field over a live listing (DESIGN §3).
 *
 * The listing always shows a real folder — the deepest one on the typed path
 * that exists — filtered by whatever is being typed after the last separator,
 * and falling back to the whole folder when that matches nothing, so the panel
 * never goes blank at the moment a name is being invented.
 *
 * Tab accepts the highlighted candidate: into a folder, or a filename filled in
 * whole. Pressing it again walks the list. Shift+Tab is the way back out.
 *
 * Shared by the workspace picker and the memory-directory dialog, which want
 * the same browsing and different endings — so what a row *means* is the
 * caller's business, and everything above is not.
 */

/**
 * `..` is part of the same list as everything else, at index -1. One cursor for
 * the whole listing is what keeps `..` from lighting up alongside a row rather
 * than instead of it, and lets the arrow keys, Tab and Enter reach it like any
 * other candidate.
 */
const UP = -1;

/** What the browser has worked out about the typed path, for the caller's buttons. */
export interface PathState {
  /** The folder the rows came from; the nearest real ancestor when the path is bad. */
  base: string;
  /** The typed folder does not exist. */
  missing: boolean;
  info: PathInspectResponse | null;
}

export interface PathBrowserProps {
  path: string;
  onPathChange: (path: string) => void;
  placeholder?: string;
  /** Reported on every resolve, so the caller can enable its own actions. */
  onState?: (state: PathState) => void;
  /** Which rows can be clicked. Directories are always navigable. */
  fileActionable?: (entry: PathCompletion) => boolean;
  /** A file row was chosen. Directories are handled here, by descending. */
  onActivateFile?: (entry: PathCompletion) => void;
  /** Enter with nothing else to do — the caller's primary action. */
  onSubmit?: () => void;
  /** Rows above the listing, e.g. an offer to create what was typed. */
  children?: JSX.Element;
  /** A control beside the field, on the same row — the caller's primary action. */
  trailing?: JSX.Element;
}

export function PathBrowser(props: PathBrowserProps) {
  const [entries, setEntries] = createSignal<PathCompletion[]>([]);
  const [base, setBase] = createSignal("");
  const [separator, setSeparator] = createSignal<"/" | "\\">("/");
  const [missing, setMissing] = createSignal(false);
  const [info, setInfo] = createSignal<PathInspectResponse | null>(null);
  const [index, setIndex] = createSignal(0);

  let input: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;
  let timer: number | undefined;
  /** Guards against a slow response overwriting a newer one. */
  let generation = 0;

  onCleanup(() => {
    if (timer) window.clearTimeout(timer);
  });

  createEffect(
    on(
      () => props.path,
      (value) => {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(async () => {
          const mine = ++generation;
          const [completed, inspected] = await Promise.allSettled([
            api.completePath(value),
            api.inspectPath(value),
          ]);
          if (mine !== generation) return;

          if (completed.status === "fulfilled") {
            setEntries(completed.value.completions);
            setBase(completed.value.base);
            setSeparator(completed.value.separator);
            setMissing(completed.value.missing && value.trim() !== "");
            // A fresh listing starts on its first entry, not on `..`: going
            // forward is the common move, and `..` is one arrow key away.
            setIndex(completed.value.completions.length > 0 ? 0 : UP);
          }
          setInfo(inspected.status === "fulfilled" ? inspected.value : null);
          props.onState?.({ base: base(), missing: missing(), info: info() });
        }, 110);
      },
    ),
  );

  createEffect(() => {
    const i = index();
    list?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" });
  });

  const filtering = () => props.path.trim() !== "" && !/[/\\]$/.test(props.path);
  const withTrailing = (value: string) => (/[/\\]$/.test(value) ? value : value + separator());

  /**
   * `picker-base` truncates from the left with `direction: rtl`, which throws a
   * trailing separator to the visual front — `…\docs\` renders as `\…\docs`. A
   * folder on screen does not need the separator anyway.
   */
  const shownBase = () => base().replace(/[/\\]+$/, "") || base();

  const setPath = (value: string) => {
    resetCycle();
    props.onPathChange(value);
  };

  const hasUp = () => {
    const parent = info()?.parent;
    return info()?.type === "directory" && parent !== null && parent !== undefined && !filtering();
  };
  const firstIndex = () => (hasUp() ? UP : 0);

  /** An empty parent is the roots listing, which an empty path is how you ask for. */
  const goUp = () => {
    const parent = info()?.parent;
    if (parent === null || parent === undefined) return;
    setPath(parent === "" ? "" : withTrailing(parent));
    input?.focus();
  };

  const activate = (entry: PathCompletion) => {
    if (entry.type === "file") {
      props.onActivateFile?.(entry);
      return;
    }
    setPath(withTrailing(entry.path));
    input?.focus();
  };

  /**
   * Tab, and the button that stands in for it where there is no keyboard.
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
    // Accepting `..` is going up, the same as clicking it.
    if (!cycle && index() === UP && hasUp()) {
      goUp();
      return;
    }
    if (cycle) {
      cycle.at = (cycle.at + 1) % cycle.items.length;
    } else {
      const items = entries();
      if (items.length === 0) return;
      cycle = { items, at: Math.max(0, Math.min(index(), items.length - 1)) };
    }

    const entry = cycle.items[cycle.at]!;
    const next = entry.type === "file" ? entry.path : withTrailing(entry.path);
    // Deliberately not through `setPath`: this *is* the cycle advancing.
    props.onPathChange(next);
    // Stepping into a folder is a fresh set of candidates, not a continuation.
    if (entry.type !== "file") resetCycle();
    input?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const items = entries();
    const last = items.length - 1;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((i) => (i >= last ? firstIndex() : i + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((i) => (i <= firstIndex() ? last : i - 1));
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
      if (index() === UP && hasUp()) {
        goUp();
        return;
      }
      // The caller's action outranks the highlight: something typed out in full
      // is a decision, and the fallback listing highlights a row that has
      // nothing to do with the name being invented in the field.
      if (props.onSubmit) {
        props.onSubmit();
        return;
      }
      const entry = items[index()];
      if (entry) activate(entry);
    }
  };

  return (
    <>
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
            placeholder={props.placeholder ?? "Type a path, or pick below"}
            value={props.path}
            onInput={(event) => setPath(event.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <Show when={props.path}>
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

        {/* Touch devices have no Tab key, and completion is too useful to leave
            to the ones that do. Hidden by a media query rather than a condition
            here: it is the same responsive decision the rest of the layout
            makes in CSS. */}
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
        {props.trailing}
      </div>

      {/* The listing is of a folder, not of the text in the field, and those two
          part company the moment a name is half-typed. Say which. */}
      <Show when={base()}>
        <div data-slot="picker-base" title={base()}>
          {shownBase()}
        </div>
      </Show>

      <div data-slot="picker-list" ref={list} role="listbox">
        {/* Only meaningful once we are actually inside a folder. `parent` is ""
            at a drive root, which still has the drive list above it. */}
        <Show when={hasUp()}>
          <button
            type="button"
            data-slot="path-item"
            data-index={UP}
            data-active={index() === UP ? "" : undefined}
            onMouseEnter={() => setIndex(UP)}
            onClick={goUp}
          >
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

        {props.children}

        <For each={entries()}>
          {(entry, i) => {
            const actionable = entry.type !== "file" || (props.fileActionable?.(entry) ?? false);
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
    </>
  );
}
