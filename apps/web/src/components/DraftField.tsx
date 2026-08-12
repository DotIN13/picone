import { onCleanup, onMount } from "solid-js";
import {
  DRAFT_MIME,
  draftText,
  normalize,
  parseDraft,
  serializeDraft,
  textDraft,
  type Draft,
  type DraftNode,
} from "../lib/draft.ts";

/**
 * The composer's field: a small rich text editor whose only rich thing is a
 * mention (DESIGN §57).
 *
 * `contenteditable`, not a textarea with something painted behind it. A pill
 * has to behave like one object — one press of backspace, one step of the arrow
 * key, never a caret halfway through somebody's name — and only a real inline
 * node does that. The browser gives it to us for free through
 * `contenteditable="false"`; faking it over a textarea means reimplementing the
 * caret, and getting it wrong the moment text wraps.
 *
 * The DOM is the browser's during editing. This reads a model out of it after
 * each change and only writes back for things the user did not type — picking a
 * mention, dropping a file, clearing after send. Rewriting the DOM on every
 * keystroke is what breaks undo, IME composition and mobile keyboards.
 */

export interface DraftFieldProps {
  draft: Draft;
  onDraft: (draft: Draft) => void;
  /** Where the caret is, as an offset into `draftText` — for the `@` menu. */
  onCaret: (caret: number) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  placeholder: string;
  disabled?: boolean;
  ref?: (api: DraftFieldApi) => void;
}

export interface DraftFieldApi {
  /** Replace the whole draft — an extension setting the text, or a reset. */
  set(draft: Draft): void;
  /** Put a mention where the caret is, replacing `back` characters before it. */
  insertMention(node: Extract<DraftNode, { type: "mention" }>, back: number): void;
  /** Append, for a file dropped rather than typed. */
  append(node: DraftNode): void;
  focus(): void;
}

/** A mention, as the DOM holds it. Atomic because the browser is told it is. */
function mentionElement(node: Extract<DraftNode, { type: "mention" }>): HTMLElement {
  const span = document.createElement("span");
  span.contentEditable = "false";
  span.dataset.component = "mention-pill";
  span.dataset.kind = node.kind;
  span.dataset.mentionId = node.id;
  span.dataset.mentionLabel = node.label;
  span.textContent = `@${node.label}`;
  return span;
}

function nodeOf(el: Element): DraftNode | null {
  const id = (el as HTMLElement).dataset?.mentionId;
  const label = (el as HTMLElement).dataset?.mentionLabel;
  const kind = (el as HTMLElement).dataset?.kind;
  if (!id || !label || (kind !== "subject" && kind !== "file")) return null;
  return { type: "mention", kind, id, label };
}

/** The model the DOM currently represents. */
function readDraft(root: HTMLElement): Draft {
  const draft: Draft = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      draft.push({ type: "text", text: child.textContent ?? "" });
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;
    if (child.tagName === "BR") {
      /*
       * A trailing `<br>` is the browser's, not the user's. Every engine keeps
       * one at the end of an editable box so the last line has a height to be
       * clicked into, and it appears the moment a field is emptied. Read as a
       * newline it made an emptied field hold `"\n"` forever: never equal to
       * empty, so the placeholder never came back, and a file dropped into an
       * untouched composer led with a blank line. A real trailing newline is
       * two of them, and the first still counts.
       */
      if (child === root.lastChild) continue;
      draft.push({ type: "text", text: "\n" });
      continue;
    }
    const mention = nodeOf(child);
    if (mention) {
      draft.push(mention);
      continue;
    }
    // Anything else — a stray element from a paste the browser normalised —
    // contributes its text and nothing more.
    draft.push({ type: "text", text: child.textContent ?? "" });
  }
  return normalize(draft);
}

/** A draft as DOM: mentions atomic, newlines as `<br>`, and nothing else. */
function draftFragment(draft: Draft): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const node of draft) {
    if (node.type === "mention") {
      fragment.appendChild(mentionElement(node));
      continue;
    }
    for (const [index, line] of node.text.split("\n").entries()) {
      if (index > 0) fragment.appendChild(document.createElement("br"));
      if (line !== "") fragment.appendChild(document.createTextNode(line));
    }
  }
  return fragment;
}

/** Write a draft into the element. Only for changes the user did not type. */
function writeDraft(root: HTMLElement, draft: Draft): void {
  root.replaceChildren(draftFragment(draft));
}

/** How far into `draftText` the caret sits, counting a mention as its label. */
function caretOffset(root: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return draftText(readDraft(root)).length;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(root);
  range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);

  let offset = 0;
  const walk = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (!range.intersectsNode(child)) continue;
      if (child instanceof HTMLElement && nodeOf(child)) {
        offset += (child.textContent ?? "").length;
        continue;
      }
      if (child.nodeType === Node.TEXT_NODE) {
        const end = selection.getRangeAt(0).endContainer === child ? selection.getRangeAt(0).endOffset : (child.textContent ?? "").length;
        offset += end;
        continue;
      }
      if (child instanceof HTMLElement && child.tagName === "BR") offset += 1;
    }
  };
  walk(root);
  return offset;
}

/** Put the caret straight after a node, in a text node it can live in. */
function caretAfter(node: Node): void {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** The mention immediately before or after a collapsed caret, if any. */
function adjacentMention(root: HTMLElement, side: "before" | "after"): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;

  const { startContainer: node, startOffset: offset } = range;

  /*
   * The caret is rarely "on" a mention. It is at the end of the text node in
   * front of it, or at the start of the one behind it, or between children of
   * the root — so each of those has to be normalised to the same question.
   */
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (side === "before" && offset !== 0) return null;
    if (side === "after" && offset !== text.length) return null;
    const sibling = side === "before" ? node.previousSibling : node.nextSibling;
    return sibling instanceof HTMLElement && nodeOf(sibling) ? sibling : null;
  }

  if (node === root) {
    const index = side === "before" ? offset - 1 : offset;
    const child = root.childNodes[index];
    return child instanceof HTMLElement && nodeOf(child) ? child : null;
  }

  return null;
}

export function DraftField(props: DraftFieldProps) {
  let el: HTMLDivElement | undefined;

  /** Read the DOM back into the model, and report where the caret ended up. */
  const sync = () => {
    if (!el) return;
    props.onDraft(readDraft(el));
    props.onCaret(caretOffset(el));
  };

  const api: DraftFieldApi = {
    set(draft) {
      if (!el) return;
      writeDraft(el, draft);
      props.onDraft(normalize(draft));
      const last = el.lastChild;
      if (last) caretAfter(last);
      props.onCaret(draftText(draft).length);
    },
    insertMention(node, back) {
      if (!el) return;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);

      // Swallow the `@query` that summoned it, then leave a space so the
      // sentence can carry on without the caret being trapped against a pill.
      if (back > 0 && range.startContainer.nodeType === Node.TEXT_NODE) {
        range.setStart(range.startContainer, Math.max(0, range.startOffset - back));
      }
      range.deleteContents();

      const pill = mentionElement(node);
      const after = document.createTextNode(" ");
      range.insertNode(after);
      range.insertNode(pill);
      caretAfter(after);
      sync();
    },
    append(node) {
      if (!el) return;
      const current = readDraft(el);
      const text = draftText(current);
      const spaced: Draft = text === "" || text.endsWith(" ") ? current : [...current, { type: "text", text: " " }];
      api.set(normalize([...spaced, node, { type: "text", text: " " }]));
    },
    focus() {
      el?.focus();
    },
  };

  props.ref?.(api);

  onMount(() => {
    if (!el) return;
    writeDraft(el, props.draft);

    /** Put a draft where the selection is, mentions intact. Paste and drop. */
    const insertAtSelection = (nodes: Draft) => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const fragment = draftFragment(nodes);
      const last = fragment.lastChild;
      range.insertNode(fragment);
      if (last) caretAfter(last);
      sync();
    };

    /** What is selected, as a draft — for the clipboard and for a drag. */
    const selectionDraft = (): Draft | null => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
      const holder = document.createElement("div");
      holder.appendChild(selection.getRangeAt(0).cloneContents());
      return readDraft(holder);
    };

    /*
     * Deletion is intercepted here rather than on `keydown` because this is
     * where the browser says what it is about to do — the same event covers a
     * backspace, a mobile keyboard's delete, and whatever an IME decides that
     * means. Only when a mention is the thing that would be partly eaten.
     *
     * A drop is caught here too, for a related reason: the browser's idea of
     * inserting one is the drag's `text/html`, so a sentence dragged out of the
     * transcript arrives wearing that page's spans, colours and font sizes in a
     * field that has no formatting to speak of. This is a *later* hook than the
     * `drop` event, and that is the point — cancelling the drop would cancel
     * the whole gesture, including the half of a move that takes the text out
     * of where it came from. Cancelling only the insertion leaves that alone.
     */
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === "insertFromDrop") {
        const data = event.dataTransfer;
        if (!data) return;
        event.preventDefault();

        // The caret is wherever it was; the drop landed where it landed.
        const target = event.getTargetRanges()[0];
        if (target && el!.contains(target.startContainer)) {
          const range = document.createRange();
          range.setStart(target.startContainer, target.startOffset);
          range.setEnd(target.endContainer, target.endOffset);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }

        // Same rule as a paste: only our own payload rebuilds mentions.
        insertAtSelection(parseDraft(data.getData(DRAFT_MIME)) ?? textDraft(data.getData("text/plain")));
        return;
      }

      const backward = event.inputType === "deleteContentBackward";
      const forward = event.inputType === "deleteContentForward";
      if (!backward && !forward) return;

      const pill = adjacentMention(el!, backward ? "before" : "after");
      if (!pill) return;

      event.preventDefault();
      const anchor = pill.previousSibling;
      pill.remove();
      if (anchor) caretAfter(anchor);
      else {
        const range = document.createRange();
        range.setStart(el!, 0);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      sync();
    };

    /*
     * Two flavours on the clipboard: ours, which keeps the mentions whole, and
     * plain text for everywhere else. Pasting into Slack should give words;
     * pasting back in here should give the same pills.
     */
    const onCopy = (event: ClipboardEvent) => {
      const draft = selectionDraft();
      if (!draft || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", draftText(draft));
      event.clipboardData.setData(DRAFT_MIME, serializeDraft(draft));
      if (event.type === "cut") {
        window.getSelection()?.deleteFromDocument();
        sync();
      }
    };

    /*
     * Dragging out of the field carries the same two flavours, and only those.
     * `clearData` first because the browser would otherwise put the selection's
     * markup on as `text/html` — which is what another editor would take, so a
     * mention would arrive somewhere else as a styled box rather than a name.
     */
    const onDragStart = (event: DragEvent) => {
      const draft = selectionDraft();
      if (!draft || !event.dataTransfer) return;
      event.dataTransfer.clearData();
      event.dataTransfer.setData("text/plain", draftText(draft));
      event.dataTransfer.setData(DRAFT_MIME, serializeDraft(draft));
    };

    /*
     * Mentions are only rebuilt from our own payload. Plain `@notes.md` from
     * somewhere else is words: which file it meant is not recoverable, and
     * guessing would attach the wrong identity to the right-looking label.
     */
    const onPaste = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      event.preventDefault();
      insertAtSelection(
        parseDraft(event.clipboardData.getData(DRAFT_MIME)) ?? textDraft(event.clipboardData.getData("text/plain")),
      );
    };

    el.addEventListener("beforeinput", onBeforeInput);
    el.addEventListener("copy", onCopy);
    el.addEventListener("cut", onCopy);
    el.addEventListener("dragstart", onDragStart);
    el.addEventListener("paste", onPaste);
    onCleanup(() => {
      el?.removeEventListener("beforeinput", onBeforeInput);
      el?.removeEventListener("copy", onCopy);
      el?.removeEventListener("cut", onCopy);
      el?.removeEventListener("dragstart", onDragStart);
      el?.removeEventListener("paste", onPaste);
    });
  });

  return (
    <div
      ref={el}
      data-slot="composer-input"
      contentEditable={!props.disabled}
      role="textbox"
      aria-multiline="true"
      aria-label={props.placeholder}
      data-placeholder={props.placeholder}
      data-empty={props.draft.length === 0 ? "" : undefined}
      onInput={sync}
      onKeyUp={() => el && props.onCaret(caretOffset(el))}
      onClick={() => el && props.onCaret(caretOffset(el))}
      onKeyDown={props.onKeyDown}
    />
  );
}
