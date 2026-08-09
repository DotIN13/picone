import { createEffect, onCleanup } from "solid-js";
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, lineNumbers, type DecorationSet } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { FileComment } from "@picone/protocol";
import { languageExtension } from "../lib/languages.ts";

export interface Selection {
  text: string;
  lineStart: number;
  lineEnd: number;
  /** Viewport coordinates for the floating action. */
  x: number;
  y: number;
}

export interface CodeViewProps {
  content: string;
  language: string;
  comments: FileComment[];
  onSelect: (selection: Selection | null) => void;
  onResolveComment: (id: string) => void;
}

const setComments = StateEffect.define<{ comments: FileComment[]; onResolve: (id: string) => void }>();

class CommentWidget extends WidgetType {
  constructor(
    private readonly comments: FileComment[],
    private readonly onResolve: (id: string) => void,
  ) {
    super();
  }

  override eq(other: CommentWidget): boolean {
    return (
      other.comments.length === this.comments.length &&
      other.comments.every((c, i) => c.id === this.comments[i]?.id && c.status === this.comments[i]?.status)
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-comment-block";

    for (const comment of this.comments) {
      // Mirrors the LineComment display card so inline and sidebar comments match.
      const card = document.createElement("div");
      card.dataset.component = "line-comment";
      card.dataset.variant = "display";
      card.dataset.status = comment.status;

      const shell = document.createElement("div");
      shell.dataset.slot = "line-comment-shell";

      const column = document.createElement("div");
      column.dataset.slot = "line-comment-column";

      const text = document.createElement("div");
      text.dataset.slot = "line-comment-text";
      text.textContent = comment.body;
      column.appendChild(text);

      const meta = document.createElement("div");
      meta.dataset.slot = "line-comment-meta";
      meta.textContent =
        comment.lineStart == null
          ? "Comment on this file"
          : comment.lineEnd && comment.lineEnd !== comment.lineStart
            ? `Comment on lines ${comment.lineStart}–${comment.lineEnd}`
            : `Comment on line ${comment.lineStart}`;
      if (comment.status === "addressed") {
        const tag = document.createElement("span");
        tag.dataset.component = "tag";
        tag.dataset.tone = "success";
        tag.textContent = "addressed";
        meta.appendChild(tag);
      }
      column.appendChild(meta);
      shell.appendChild(column);

      const tools = document.createElement("div");
      tools.dataset.slot = "line-comment-tools";
      const resolve = document.createElement("button");
      resolve.type = "button";
      resolve.dataset.component = "button";
      resolve.dataset.variant = "ghost";
      resolve.dataset.size = "small";
      resolve.textContent = "Resolve";
      resolve.onclick = (event) => {
        event.preventDefault();
        this.onResolve(comment.id);
      };
      tools.appendChild(resolve);
      shell.appendChild(tools);

      card.appendChild(shell);
      wrap.appendChild(card);
    }
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(state: EditorState, comments: FileComment[], onResolve: (id: string) => void): DecorationSet {
  const byEndLine = new Map<number, FileComment[]>();
  const highlighted = new Set<number>();
  const totalLines = state.doc.lines;

  for (const comment of comments) {
    if (comment.status === "resolved") continue;
    const start = clamp(comment.lineStart ?? 1, 1, totalLines);
    const end = clamp(comment.lineEnd ?? start, start, totalLines);
    for (let line = start; line <= end; line++) highlighted.add(line);
    const list = byEndLine.get(end) ?? [];
    list.push(comment);
    byEndLine.set(end, list);
  }

  const builder = new RangeSetBuilder<Decoration>();
  for (let lineNo = 1; lineNo <= totalLines; lineNo++) {
    const hasHighlight = highlighted.has(lineNo);
    const widgets = byEndLine.get(lineNo);
    if (!hasHighlight && !widgets) continue;

    const line = state.doc.line(lineNo);
    if (hasHighlight) builder.add(line.from, line.from, Decoration.line({ class: "cm-commented-line" }));
    if (widgets) {
      builder.add(
        line.to,
        line.to,
        Decoration.widget({ widget: new CommentWidget(widgets, onResolve), block: true, side: 1 }),
      );
    }
  }
  return builder.finish();
}

const commentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setComments)) return buildDecorations(tr.state, effect.value.comments, effect.value.onResolve);
    }
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--v2-text-text-base)", height: "100%" },
  ".cm-scroller": {
    fontFamily: "var(--v2-font-family-mono)",
    fontSize: "12.5px",
    fontWeight: "400",
    lineHeight: "1.6",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--v2-text-text-faint)",
    paddingInlineEnd: "8px",
  },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "40px" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-content": { caretColor: "transparent", paddingBlock: "12px" },
  ".cm-cursor": { display: "none" },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--v2-background-bg-accent) 26%, transparent)",
  },
});

const highlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-primitive)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--syntax-property)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syntax-type)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--syntax-type)" },
  { tag: tags.invalid, color: "var(--syntax-critical)" },
  { tag: [tags.heading, tags.strong], fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--v2-text-text-accent)", textDecoration: "underline" },
]);

/** Read-only source view with line numbers, selection and inline comments. */
export function CodeView(props: CodeViewProps) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;

  createEffect(() => {
    // Rebuild when the document or language changes; the doc is replaced wholesale on refresh.
    const content = props.content;
    const language = props.language;
    if (!host) return;

    view?.destroy();

    const extensions: Extension[] = [
      lineNumbers(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
      syntaxHighlighting(highlightStyle),
      ...languageExtension(language),
      commentField,
      theme,
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet && !update.focusChanged) return;
        const range = update.state.selection.main;
        if (range.empty) {
          props.onSelect(null);
          return;
        }
        const coords = update.view.coordsAtPos(range.head) ?? update.view.coordsAtPos(range.from);
        props.onSelect({
          text: update.state.sliceDoc(range.from, range.to),
          lineStart: update.state.doc.lineAt(range.from).number,
          lineEnd: update.state.doc.lineAt(range.to).number,
          x: coords?.left ?? 0,
          y: coords?.bottom ?? 0,
        });
      }),
    ];

    view = new EditorView({ state: EditorState.create({ doc: content, extensions }), parent: host });
    view.dispatch({ effects: setComments.of({ comments: props.comments, onResolve: props.onResolveComment }) });
  });

  createEffect(() => {
    const comments = props.comments;
    view?.dispatch({ effects: setComments.of({ comments, onResolve: props.onResolveComment }) });
  });

  onCleanup(() => view?.destroy());

  return <div data-slot="codeview" ref={host} />;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
