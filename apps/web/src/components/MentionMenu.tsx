import { For, Show, createEffect } from "solid-js";
import type { MemorySubject } from "@picone/protocol";
import { Icon, type IconName } from "./ui/icon.tsx";

/**
 * The `@` menu: who and what the memory directories know about (DESIGN §52).
 *
 * Same shape and same keyboard as the slash menu, because they are the same
 * gesture — type a sigil, narrow a list, complete a token. Picking one only
 * inserts text; the pointer the agent receives is assembled server-side when
 * the turn is sent.
 */

/** People first. A store is mostly entities, and people are who you mean. */
const RANK: Record<string, number> = { person: 0, entity: 1, goal: 2 };

const ICON: Record<string, IconName> = {
  person: "user",
  entity: "box",
  goal: "target",
  journal: "calendar",
};

export function subjectIcon(type: string): IconName {
  return ICON[type] ?? "file";
}

/**
 * Prefix on the slug first, then the display name, then anything containing
 * the query. Typing `gio` should reach `gio-choi` before it reaches a page
 * that merely mentions Gio in its summary.
 */
export function filterSubjects(subjects: MemorySubject[], query: string): MemorySubject[] {
  const needle = query.toLowerCase();

  const byKind = (a: MemorySubject, b: MemorySubject) =>
    (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9) || a.name.localeCompare(b.name);

  if (!needle) return [...subjects].sort(byKind).slice(0, 50);

  const slugPrefix: MemorySubject[] = [];
  const namePrefix: MemorySubject[] = [];
  const contains: MemorySubject[] = [];

  for (const subject of subjects) {
    const slug = subject.slug.toLowerCase();
    const name = subject.name.toLowerCase();
    if (slug.startsWith(needle)) slugPrefix.push(subject);
    else if (name.startsWith(needle)) namePrefix.push(subject);
    else if (slug.includes(needle) || name.includes(needle) || subject.tags.some((t) => t.includes(needle))) {
      contains.push(subject);
    }
  }

  return [...slugPrefix.sort(byKind), ...namePrefix.sort(byKind), ...contains.sort(byKind)].slice(0, 50);
}

export interface MentionMenuProps {
  subjects: MemorySubject[];
  query: string;
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (subject: MemorySubject) => void;
}

export function MentionMenu(props: MentionMenuProps) {
  let list: HTMLDivElement | undefined;

  createEffect(() => {
    props.activeIndex;
    list?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  });

  return (
    <Show when={props.subjects.length > 0}>
      <div data-component="mention-menu" ref={list}>
        <For each={props.subjects}>
          {(subject, index) => (
            <button
              type="button"
              data-slot="mention-item"
              data-active={index() === props.activeIndex ? "" : undefined}
              // Pointer-down, not click: the textarea must not lose focus first.
              onPointerDown={(event) => {
                event.preventDefault();
                props.onPick(subject);
              }}
              onMouseEnter={() => props.onHover(index())}
            >
              <Icon name={subjectIcon(subject.type)} size={12} />
              <span data-slot="mention-name">{subject.name}</span>
              <Show when={subject.type}>
                <span data-slot="mention-type">{subject.type}</span>
              </Show>
              <Show when={subject.summary}>
                <span data-slot="mention-summary">{subject.summary}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

/**
 * The `@token` the caret is sitting in, or null.
 *
 * Anchored to the caret rather than the whole field, because unlike a slash
 * command a mention happens mid-sentence — `what did I promise @jul` is the
 * normal case, not the exception. The sigil must follow whitespace or an
 * opening bracket so an email address never opens the menu.
 */
export function mentionQueryAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;

  const preceding = at === 0 ? "" : before[at - 1];
  if (preceding && !/[\s([{"']/.test(preceding)) return null;

  const token = before.slice(at + 1);
  // A space closes the mention; so does a newline.
  if (/\s/.test(token)) return null;
  // Slugs are filenames.
  if (token && !/^[a-z0-9][a-z0-9._-]*$/i.test(token)) return null;

  return { query: token, start: at };
}

