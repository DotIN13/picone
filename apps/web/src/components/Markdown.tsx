import { For, Match, Show, Switch, createContext, createMemo, useContext } from "solid-js";
import DOMPurify from "dompurify";
import { marked, type Token, type Tokens } from "marked";
import { decodeEntities } from "../lib/entities.ts";
import { fenceClosed } from "../lib/fences.ts";
import { classifyTarget, isPathLike, segment, type Reference } from "../lib/references.ts";
import { resolution } from "../lib/resolver.ts";
import { openFile, revealInTree } from "../store.ts";
import { MediaReference } from "./MediaReference.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";

marked.setOptions({ gfm: true, breaks: true });

export interface MarkdownProps {
  text: string;
  /**
   * Overrides what a file reference does. Defaults to opening a tab, so a
   * markdown *file* gets working references without its viewer having to know
   * they exist — which is how they came to do nothing there the first time.
   */
  onOpenFile?: (path: string) => void;
}

/**
 * Rendered markdown for assistant messages and markdown file tabs.
 *
 * This walks marked's token tree and builds DOM nodes, rather than handing
 * `innerHTML` a string. The reason is references (DESIGN §51): showing an image
 * or a clickable path means putting *components* inside the prose, and doing
 * that to an `innerHTML` tree means re-parsing markup the sanitizer has already
 * approved and grafting nodes back in — two passes that disagree about what the
 * document is. Walking tokens has neither problem, and it removes the XSS
 * surface entirely: a text token becomes a text node, so there is no markup for
 * model output to escape from.
 *
 * The one exception is a raw HTML token, which is what it says it is. Those go
 * through DOMPurify, which is now confined to the one construct that needs it.
 */
export function Markdown(props: MarkdownProps) {
  const tokens = createMemo(() => marked.lexer(props.text));

  return (
    <OpenFile.Provider value={() => props.onOpenFile ?? ((path: string) => void openFile(path))}>
      <div data-component="markdown">
        <Nodes tokens={tokens()} />
      </div>
    </OpenFile.Provider>
  );
}

/** Passed by context rather than by prop: every level of the walk may need it. */
const OpenFile = createContext<() => (path: string) => void>(() => (path: string) => void openFile(path));

function Nodes(props: { tokens: Token[] | undefined }) {
  return <For each={props.tokens ?? []}>{(token) => <Node token={token} />}</For>;
}

function Node(props: { token: Token }) {
  const as = <T extends Token>() => props.token as T;

  return (
    <Switch fallback={<>{"text" in props.token ? decodeEntities(String(props.token.text)) : null}</>}>
      {/* --- blocks --- */}
      <Match when={props.token.type === "paragraph"}>
        <p>
          <Nodes tokens={as<Tokens.Paragraph>().tokens} />
        </p>
      </Match>

      <Match when={props.token.type === "heading"}>
        {(() => {
          const token = as<Tokens.Heading>();
          const inner = <Nodes tokens={token.tokens} />;
          // Depth is data, so the tag is chosen rather than interpolated.
          return (
            <Switch fallback={<h4>{inner}</h4>}>
              <Match when={token.depth === 1}>
                <h1>{inner}</h1>
              </Match>
              <Match when={token.depth === 2}>
                <h2>{inner}</h2>
              </Match>
              <Match when={token.depth === 3}>
                <h3>{inner}</h3>
              </Match>
            </Switch>
          );
        })()}
      </Match>

      <Match when={props.token.type === "code"}>
        <CodeBlock token={as<Tokens.Code>()} />
      </Match>

      <Match when={props.token.type === "blockquote"}>
        <blockquote>
          <Nodes tokens={as<Tokens.Blockquote>().tokens} />
        </blockquote>
      </Match>

      <Match when={props.token.type === "list"}>
        <ListBlock token={as<Tokens.List>()} />
      </Match>

      <Match when={props.token.type === "table"}>
        <TableBlock token={as<Tokens.Table>()} />
      </Match>

      <Match when={props.token.type === "hr"}>
        <hr />
      </Match>

      <Match when={props.token.type === "html"}>
        <RawHtml html={as<Tokens.HTML>().text} block={as<Tokens.HTML>().block} />
      </Match>

      {/* Link definitions produce no output, and `space` is the gap itself. */}
      <Match when={props.token.type === "space" || props.token.type === "def"}>{null}</Match>

      {/* --- inline --- */}
      <Match when={props.token.type === "text"}>
        <TextRun token={as<Tokens.Text>()} />
      </Match>

      <Match when={props.token.type === "strong"}>
        <strong>
          <Nodes tokens={as<Tokens.Strong>().tokens} />
        </strong>
      </Match>

      <Match when={props.token.type === "em"}>
        <em>
          <Nodes tokens={as<Tokens.Em>().tokens} />
        </em>
      </Match>

      <Match when={props.token.type === "del"}>
        <del>
          <Nodes tokens={as<Tokens.Del>().tokens} />
        </del>
      </Match>

      <Match when={props.token.type === "codespan"}>
        <CodeSpan text={decodeEntities(as<Tokens.Codespan>().text)} />
      </Match>

      <Match when={props.token.type === "br"}>
        <br />
      </Match>

      <Match when={props.token.type === "link"}>
        <LinkNode token={as<Tokens.Link>()} />
      </Match>

      <Match when={props.token.type === "image"}>
        <ImageNode token={as<Tokens.Image>()} />
      </Match>

      <Match when={props.token.type === "escape"}>
        <>{as<Tokens.Escape>().text}</>
      </Match>
    </Switch>
  );
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/**
 * A run of prose, with the paths and URLs in it turned into references.
 *
 * marked gives a `text` token either children or a string. Only the string case
 * is scanned — the other is a container, and scanning it would double-count.
 */
function TextRun(props: { token: Tokens.Text }) {
  const parts = createMemo(() => {
    if (props.token.tokens?.length) return null;
    return segment(decodeEntities(props.token.text));
  });

  return (
    <Show when={parts()} fallback={<Nodes tokens={props.token.tokens} />}>
      {(segments) => (
        <For each={segments()}>
          {(part) =>
            "text" in part ? (
              <>{part.text}</>
            ) : (
              <MediaReference reference={part.reference} display="inline" />
            )
          }
        </For>
      )}
    </Show>
  );
}

/**
 * Inline code that happens to name a real file becomes clickable, and does not
 * otherwise change: `src/auth.ts` in a sentence should still read as code. This
 * is the "subtler treatment" a pill would be too loud for — an agent transcript
 * is mostly paths in backticks, and a wall of pills is worse than none.
 */
function CodeSpan(props: { text: string }) {
  const openRef = useContext(OpenFile);
  const candidate = createMemo(() => {
    const text = props.text.trim();
    // Without this the batch would carry every `const` and `true` in the
    // transcript: a bare word classifies as a path, it just is not one.
    if (!isPathLike(text)) return null;
    const kind = classifyTarget(text);
    return kind === "file" || kind === "image" ? text : null;
  });
  const resolved = () => {
    const target = candidate();
    return target ? resolution(target) : undefined;
  };

  return (
    <Show when={resolved()?.exists ? resolved() : null} fallback={<code>{props.text}</code>}>
      {(hit) => (
        <code
          data-slot="code-reference"
          data-type={hit().type}
          title={hit().absolute}
          onClick={() => {
            const absolute = hit().absolute ?? props.text;
            if (hit().type === "directory") void revealInTree(absolute);
            else openRef()(absolute);
          }}
        >
          {props.text}
        </code>
      )}
    </Show>
  );
}

function LinkNode(props: { token: Tokens.Link }) {
  const openRef = useContext(OpenFile);
  const href = () => props.token.href ?? "";
  const external = () => /^[a-z][a-z0-9+.-]*:/i.test(href()) && !href().startsWith("file:");

  return (
    <a
      href={href()}
      title={props.token.title ?? undefined}
      target={external() ? "_blank" : undefined}
      rel={external() ? "noopener noreferrer" : undefined}
      onClick={(event) => {
        if (external()) return;
        event.preventDefault();
        openRef()(href().replace(/^file:\/\//, ""));
      }}
    >
      <Nodes tokens={props.token.tokens} />
    </a>
  );
}

/**
 * `![alt](target)` is an explicit request to see the thing, so this is the one
 * place a reference renders as a block by default.
 */
function ImageNode(props: { token: Tokens.Image }) {
  const reference = createMemo((): Reference | null => {
    const target = props.token.href ?? "";
    const kind = classifyTarget(target);
    // An image whose target does not look like media — a bare `![x](y)` — is
    // still an image as far as markdown is concerned.
    return kind ? { kind: kind === "file" ? "image" : kind, target, start: 0, end: target.length } : null;
  });

  return (
    <Show when={reference()} fallback={<>{props.token.text}</>}>
      {(ref) => <MediaReference reference={ref()} display="block" label={props.token.text || undefined} />}
    </Show>
  );
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function CodeBlock(props: { token: Tokens.Code }) {
  const lang = () => ((props.token.lang ?? "").trim().split(/\s+/)[0] ?? "").toLowerCase();
  const complete = () => fenceClosed(props.token.raw ?? "");

  return (
    <Switch
      fallback={
        <pre>
          <code data-language={lang() || undefined}>{props.token.text}</code>
        </pre>
      }
    >
      <Match when={lang() === "mermaid" && complete()}>
        <MermaidBlock code={props.token.text} />
      </Match>
      <Match when={lang() === "diff" || lang() === "patch"}>
        <DiffBlock text={props.token.text} />
      </Match>
    </Switch>
  );
}

/**
 * A fenced diff, coloured the way a tool call's patch already is. The agent
 * writes both, and there is no reason the same content should look like two
 * different things depending on which one carried it.
 */
function DiffBlock(props: { text: string }) {
  const lines = createMemo(() => props.text.split("\n"));
  const tone = (line: string) =>
    line.startsWith("+++") || line.startsWith("---")
      ? "meta"
      : line.startsWith("@@")
        ? "hunk"
        : line.startsWith("+")
          ? "add"
          : line.startsWith("-")
            ? "del"
            : undefined;

  return (
    <pre data-component="diff-block">
      <For each={lines()}>{(line) => <div data-tone={tone(line)}>{line || " "}</div>}</For>
    </pre>
  );
}

function ListBlock(props: { token: Tokens.List }) {
  const items = () => props.token.items;

  const body = (
    <For each={items()}>
      {(item) => (
        <li data-task={item.task ? "" : undefined}>
          <Show when={item.task}>
            <input type="checkbox" checked={item.checked ?? false} disabled />
          </Show>
          <Nodes tokens={item.tokens} />
        </li>
      )}
    </For>
  );

  return (
    <Show when={props.token.ordered} fallback={<ul>{body}</ul>}>
      <ol start={props.token.start === "" ? undefined : Number(props.token.start)}>{body}</ol>
    </Show>
  );
}

/** marked's alignment is `left | center | right | null`; CSS wants the same. */
function alignStyle(align: "center" | "left" | "right" | null | undefined) {
  return align ? ({ "text-align": align } as const) : undefined;
}

function TableBlock(props: { token: Tokens.Table }) {
  const align = (index: number) => props.token.align[index] ?? undefined;

  return (
    <table>
      <thead>
        <tr>
          <For each={props.token.header}>
            {(cell, index) => (
              <th style={alignStyle(align(index()))}>
                <Nodes tokens={cell.tokens} />
              </th>
            )}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={props.token.rows}>
          {(row) => (
            <tr>
              <For each={row}>
                {(cell, index) => (
                  <td style={alignStyle(align(index()))}>
                    <Nodes tokens={cell.tokens} />
                  </td>
                )}
              </For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

/**
 * The only markup that reaches the DOM as markup. Sanitized every time, and
 * deliberately not memoized on the raw string: the cost is a few microseconds
 * and the alternative is a cache that could be poisoned by a repeat.
 */
function RawHtml(props: { html: string; block?: boolean }) {
  const clean = () => DOMPurify.sanitize(props.html);
  return (
    <Show when={props.block} fallback={<span innerHTML={clean()} />}>
      <div innerHTML={clean()} />
    </Show>
  );
}
