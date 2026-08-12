import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { MemorySubject, SlashCommand, WidgetLine } from "@picone/protocol";
import {
  abort,
  activeCapabilities,
  activeSessionState,
  compactSession,
  exportSession,
  reloadSession,
  sessionStats,
  setAutoCompaction,
  closeTab,
  consumeEditorInsert,
  consumeEditorPatch,
  newSession,
  reportEditorText,
  sendPrompt,
  setSettingsOpen,
  state,
  toggleColorScheme,
  toggleSidebar,
  surfaceOf,
  widgetsAt,
} from "../store.ts";
import { COMPACT_QUERY, mediaQuery } from "../lib/media.ts";
import { draftForModel, draftText, textDraft, type Draft } from "../lib/draft.ts";
import { parseWidgetRows } from "../lib/widget-lines.ts";
import { Dictation, isSpeechInputSupported, stopSpeaking } from "../voice/speech.ts";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Switch } from "./ui/primitives.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { SlashMenu, filterCommands } from "./SlashMenu.tsx";
import { MentionMenu, filterSubjects, mentionQueryAt } from "./MentionMenu.tsx";
import { DraftField, type DraftFieldApi } from "./DraftField.tsx";

/**
 * A header or footer an extension drew (§55).
 *
 * Pi puts the header above the chat and the footer along the bottom; here both
 * sit with the composer, which is the nearest equivalent Picone has to a status
 * line and keeps extension chrome in one place rather than two.
 */
export function ExtensionChrome(props: { slot: "header" | "footer" }) {
  const lines = () => (props.slot === "header" ? surfaceOf().header : surfaceOf().footer);
  return (
    <Show when={lines()?.length ? lines() : null}>
      {(rows) => (
        <div data-slot="ext-chrome" data-chrome={props.slot}>
          <For each={rows()}>{(line) => <div>{spans(line)}</div>}</For>
        </div>
      )}
    </Show>
  );
}

/** A line's runs, each carrying whatever role the widget declared for it. */
function spans(line: WidgetLine) {
  return (
    <For each={line}>
      {(span) => (
        <span data-slot="widget-span" data-role={span.role} data-bold={span.bold ? "" : undefined}>
          {span.text}
        </span>
      )}
    </For>
  );
}

/** The lines a widget drew, less the leading one the fold already shows. */
function afterFirst(lines: WidgetLine[]): WidgetLine[] {
  const first = lines.findIndex((line) => line.some((span) => span.text.trim() !== ""));
  return first === -1 ? [] : lines.slice(first + 1);
}

/** One widget's rows, or its text as drawn when the layout is switched off. */
function WidgetBody(props: { lines: WidgetLine[]; folded?: boolean }) {
  const lines = createMemo(() => (props.folded ? afterFirst(props.lines) : props.lines));
  const rows = createMemo(() => parseWidgetRows(props.lines).slice(props.folded ? 1 : 0));
  return (
    <Show
      when={state.app.appearance.layoutWidgets}
      fallback={<pre data-slot="widget-verbatim">{lines().map((line) => spans(line)).map(withNewline)}</pre>}
    >
      <For each={rows()}>
        {(row) => (
          <Show when={row.kind === "row" ? row : null} fallback={<div data-slot="widget-gap" />}>
            {(item) => (
              <div
                data-slot="widget-row"
                data-heading={item().heading ? "" : undefined}
                style={{ "padding-inline-start": `${item().depth * 14}px` }}
              >
                {spans(item().spans)}
              </div>
            )}
          </Show>
        )}
      </For>
    </Show>
  );
}

/** In a `<pre>`, the line break is the layout, so it has to be in the text. */
const withNewline = (line: JSX.Element) => [line, "\n"];

/**
 * Line blocks an extension pushed via `setWidget` (§55).
 *
 * On a phone they are folded down to their first line, which is where a widget
 * puts its title and its count. Two of them expanded is most of the screen
 * above the composer, and the thing you came to read is the conversation; the
 * heading is enough to say whether it is worth opening.
 */
function ExtensionWidgets(props: { placement: "aboveEditor" | "belowEditor" }) {
  const widgets = () => widgetsAt(props.placement);
  const compact = mediaQuery(COMPACT_QUERY);
  /** By key, so a widget redrawing mid-turn does not close itself. */
  const [opened, setOpened] = createSignal<string[]>([]);

  const open = (key: string) => !compact() || opened().includes(key);
  const toggle = (key: string) =>
    setOpened((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]));

  return (
    <Show when={widgets().length > 0}>
      <div data-slot="ext-widgets" data-placement={props.placement}>
        <For each={widgets()}>
          {(widget) => {
            const head = createMemo(() => {
              const first = parseWidgetRows(widget.lines)[0];
              return first?.kind === "row" ? first.spans : [{ text: "Widget" }];
            });
            // Nothing to fold away when the whole widget is its first line.
            const foldable = () => compact() && afterFirst(widget.lines).length > 0;

            return (
              <div
                data-slot="ext-widget"
                data-verbatim={state.app.appearance.layoutWidgets ? undefined : ""}
                data-folded={foldable() && !open(widget.key) ? "" : undefined}
              >
                <Show when={foldable()}>
                  <button
                    type="button"
                    data-slot="widget-summary"
                    aria-expanded={open(widget.key)}
                    onClick={() => toggle(widget.key)}
                  >
                    <span data-slot="widget-row" data-heading="">
                      {spans(head())}
                    </span>
                    <Icon name={open(widget.key) ? "chevron-up" : "chevron-down"} size={13} />
                  </button>
                </Show>
                <Show when={open(widget.key)}>
                  {/* The heading is the button when folding; showing it twice
                      would only repeat what was just tapped. */}
                  <WidgetBody lines={widget.lines} folded={foldable()} />
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/** Commands handled in the browser; they never reach Pi. */
const APP_COMMANDS: SlashCommand[] = [
  { name: "new", description: "Start a new session in a new tab — `/new claude` to choose the agent", source: "app" },
  { name: "close", description: "Close the current tab", source: "app" },
  { name: "settings", description: "Open workspace settings", source: "app" },
  { name: "theme", description: "Toggle light / dark theme", source: "app" },
  { name: "sidebar", description: "Show or hide the sidebar", source: "app" },
  { name: "compact", description: "Summarise the conversation so far to free context", source: "app" },
  {
    name: "reload",
    description: "Re-read skills, extensions and workspace settings into this session",
    source: "app",
  },
  { name: "stats", description: "Messages, tokens and cost for this session", source: "app" },
  { name: "export", description: "Write this session out as an HTML file", source: "app" },
];

export function Composer() {
  /**
   * The draft is a document, not a string (§57).
   *
   * `text()` is derived from it for everything that wants words — the slash
   * menu, the mirror to the server, the message the transcript shows — while
   * the mentions inside it keep the identity they were picked with.
   */
  const [draft, setDraft] = createSignal<Draft>([]);
  const text = () => draftText(draft());
  const [listening, setListening] = createSignal(false);
  const [voiceError, setVoiceError] = createSignal<string | null>(null);
  const [menuIndex, setMenuIndex] = createSignal(0);
  /** Mentions happen mid-sentence, so the menu keys off the caret, not the field. */
  const [caret, setCaret] = createSignal(0);
  /** Offset of an `@` whose menu was dismissed with Escape. */
  const [dismissed, setDismissed] = createSignal<number | null>(null);

  const dictation = new Dictation();
  let baseText = "";
  let field: DraftFieldApi | undefined;

  const busy = () => activeSessionState() !== "idle";
  const disabled = () => state.activeSessionId === null;

  /** The slash menu is open while the text is a single `/token` with no space. */
  const slashQuery = createMemo(() => {
    const value = text();
    if (!value.startsWith("/")) return null;
    const token = value.slice(1);
    return /\s/.test(token) ? null : token;
  });

  /**
   * The app's own commands, minus the ones this session's agent cannot do
   * (§57). Compaction, reload and export are all agent-dependent, and offering
   * one that answers "not supported" is worse than not offering it.
   */
  const appCommands = createMemo(() => {
    const caps = activeCapabilities();
    if (!caps) return APP_COMMANDS;
    return APP_COMMANDS.filter((command) => {
      if (command.name === "compact") return caps.compact;
      if (command.name === "reload") return caps.reload;
      if (command.name === "export") return caps.exportHtml;
      return true;
    });
  });

  const commands = createMemo(() => {
    const sessionId = state.activeSessionId;
    const agentCommands = sessionId ? (state.commands[sessionId] ?? []) : [];
    return [...appCommands(), ...agentCommands];
  });

  const matches = createMemo(() => {
    const query = slashQuery();
    return query === null ? [] : filterCommands(commands(), query);
  });

  /** `@token` under the caret (DESIGN §52). Suppressed while `/` owns the menu. */
  const mention = createMemo(() => {
    if (slashQuery() !== null) return null;
    const found = mentionQueryAt(text(), caret());
    // Dismissal is remembered per `@`, so Escape closes this one and typing a
    // different mention later still opens the menu.
    return found && found.start === dismissed() ? null : found;
  });

  const mentionMatches = createMemo(() => {
    const active = mention();
    return active === null ? [] : filterSubjects(state.memorySubjects, active.query);
  });

  /** Exactly one menu is ever open, and the keyboard belongs to whichever it is. */
  const openMenu = createMemo<"slash" | "mention" | null>(() =>
    matches().length > 0 ? "slash" : mentionMatches().length > 0 ? "mention" : null,
  );

  createEffect(() => {
    // Reset the highlight whenever either candidate list changes.
    matches();
    mentionMatches();
    setMenuIndex(0);
  });

  // Mirror the composer to the server so `getEditorText()` returns something
  // real. Debounced — extensions read it occasionally, not per keystroke.
  let echo: number | undefined;
  createEffect(() => {
    const value = text();
    if (echo) window.clearTimeout(echo);
    echo = window.setTimeout(() => reportEditorText(value), 200);
  });

  // An extension called setEditorText/pasteToEditor.
  createEffect(() => {
    const patch = state.editorPatch;
    if (!patch) return;
    field?.set(textDraft(patch.text));
    consumeEditorPatch();
    field?.focus();
  });

  /**
   * A file or directory handed over by the tree or the tab bar (§57).
   *
   * Appended rather than inserted at the caret: a drop has no caret to speak
   * of, and a path landing in the middle of a half-typed word is not what
   * anyone means by dropping it there.
   */
  createEffect(() => {
    const dropped = state.editorInsert;
    if (!dropped) return;
    consumeEditorInsert();
    const label = dropped.text.split(/[\\/]/).pop() || dropped.text;
    field?.append({ type: "mention", kind: "file", id: dropped.text, label });
    field?.focus();
  });

  const runAppCommand = (name: string, argument?: string): boolean => {
    switch (name) {
      case "new":
        // `/new claude` starts one with that agent (§57); `/new` takes the
        // workspace's usual one, which is what it has always done.
        void newSession(argument === "claude" || argument === "pi" ? argument : undefined);
        return true;
      case "close":
        if (state.activeTabId) closeTab(state.activeTabId);
        return true;
      case "settings":
        setSettingsOpen(true);
        return true;
      case "theme":
        toggleColorScheme();
        return true;
      case "sidebar":
        toggleSidebar();
        return true;
      case "compact":
        compactSession();
        return true;
      case "reload":
        reloadSession();
        return true;
      case "stats":
        sessionStats();
        return true;
      case "export":
        exportSession();
        return true;
      default:
        return false;
    }
  };

  const pickCommand = (command: SlashCommand) => {
    if (command.source === "app") {
      runAppCommand(command.name);
      field?.set([]);
      return;
    }
    // Pi expands prompt templates and runs extension commands itself, so the
    // composer only has to complete the token and let the user add arguments.
    field?.set(textDraft(`/${command.name} `));
    field?.focus();
  };

  /**
   * Complete the token in place, as a mention node (§52).
   *
   * The `@query` that summoned the menu is swallowed and a pill takes its
   * place, carrying the slug — so identity is settled here, once, rather than
   * being read back out of the words afterwards.
   */
  const pickSubject = (subject: MemorySubject) => {
    const active = mention();
    if (!active) return;
    field?.insertMention(
      { type: "mention", kind: "subject", id: subject.slug, label: subject.name },
      caret() - active.start,
    );
    field?.focus();
  };

  const submit = (source: "chat" | "voice" = "chat") => {
    const value = text().trim();
    if (!value) return;

    const [word, ...rest] = value.split(/\s+/);
    const appCommand = value.startsWith("/") ? APP_COMMANDS.find((c) => `/${c.name}` === word) : undefined;
    if (appCommand) {
      runAppCommand(appCommand.name, rest.join(" ").trim() || undefined);
      field?.set([]);
      return;
    }

    /*
     * Two readings of the same draft (§57): what the agent is given, where a
     * file mention is the path it stands for, and what the transcript shows,
     * where it stays the name that was picked. Derived from the document, so
     * neither has to be recovered from the other.
     */
    const sent = draftForModel(draft());
    // During an active run this becomes steering server-side (DESIGN §28).
    sendPrompt(sent, source, sent === value ? undefined : value);
    field?.set([]);
    stopSpeaking();
  };

  const toggleDictation = () => {
    if (listening()) {
      dictation.stop();
      return;
    }
    setVoiceError(null);
    baseText = text() ? `${text()} ` : "";
    const started = dictation.start({
      onTranscript: (transcript) => field?.set(textDraft(`${baseText}${transcript}`)),
      onError: setVoiceError,
      onEnd: () => setListening(false),
    });
    if (started) setListening(true);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const menu = openMenu();
    if (menu) {
      const length = menu === "slash" ? matches().length : mentionMatches().length;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMenuIndex((i) => (i + 1) % length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMenuIndex((i) => (i - 1 + length) % length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        if (menu === "slash") {
          const command = matches()[menuIndex()];
          if (command) {
            event.preventDefault();
            pickCommand(command);
            return;
          }
        } else {
          const subject = mentionMatches()[menuIndex()];
          if (subject) {
            event.preventDefault();
            pickSubject(subject);
            return;
          }
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        // A slash command is the whole message, so dismissing it clears the
        // field. A mention is one word inside a sentence — closing the menu
        // must not throw the sentence away, so the caret steps past the token.
        if (menu === "slash") field?.set([]);
        else setDismissed(mention()?.start ?? null);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(listening() ? "voice" : "chat");
    }
  };

  return (
    <div data-slot="composer">
      <Show when={voiceError()}>{(error) => <div data-slot="composer-error">{error()}</div>}</Show>

      <div data-slot="composer-shell">
        <ExtensionChrome slot="header" />
        <ExtensionWidgets placement="aboveEditor" />

        <SlashMenu
          commands={matches()}
          query={slashQuery() ?? ""}
          activeIndex={menuIndex()}
          onHover={setMenuIndex}
          onPick={pickCommand}
        />

        <Show when={openMenu() === "mention"}>
          <MentionMenu
            subjects={mentionMatches()}
            query={mention()?.query ?? ""}
            activeIndex={menuIndex()}
            onHover={setMenuIndex}
            onPick={pickSubject}
          />
        </Show>

        {/*
          No drop handler of its own. A mention is only created by the two
          things that know they are handing over a file — a row in the tree and
          a file tab, both of which carry a path through `mentionPath` — and
          dropping anything else, a paragraph out of the transcript or a URL
          from another window, lands as the text it is. It used to accept any
          `text/plain` and turn it into a pill, which made a mention out of
          things that were never files.
        */}
        <div data-slot="composer-box" data-listening={listening() ? "" : undefined}>
          <DraftField
            ref={(api) => (field = api)}
            draft={draft()}
            onDraft={setDraft}
            onCaret={setCaret}
            onKeyDown={onKeyDown}
            disabled={disabled()}
            placeholder={
              disabled() ? "Open a session to start" : busy() ? "Steer the agent…" : "Ask anything, or / for commands"
            }
          />

          <div data-slot="composer-controls">
            <Show when={state.voice.input && isSpeechInputSupported()}>
              <button
                type="button"
                data-slot="composer-mic"
                data-on={listening() ? "" : undefined}
                aria-pressed={listening()}
                aria-label={listening() ? "Stop dictation" : "Dictate"}
                title={listening() ? "Stop dictation" : "Dictate"}
                disabled={disabled()}
                onClick={toggleDictation}
              >
                <Icon name="mic" size={14} />
              </button>
            </Show>

            <ModelPicker />

            <div class="flex-1" />

            {/*
              Stop is what an empty composer offers while the agent runs. The
              moment there is something typed, the button becomes Send — that
              text is steering (DESIGN §28), and having to clear the box to
              reach a send button, or press Enter on a control that reads
              "stop", is the wrong way round. Emptying the field brings Stop
              back.
            */}
            <Show
              when={busy() && !text().trim()}
              fallback={
                <button
                  type="button"
                  data-slot="composer-send"
                  disabled={!text().trim() || disabled()}
                  aria-label={busy() ? "Steer the agent" : "Send"}
                  onClick={() => submit()}
                >
                  <Icon name="arrow-up" size={14} />
                </button>
              }
            >
              <button type="button" data-slot="composer-stop" aria-label="Stop the agent" onClick={abort}>
                <Icon name="stop" size={11} fill="currentColor" />
              </button>
            </Show>
          </div>
        </div>

        <ExtensionWidgets placement="belowEditor" />
        <ExtensionChrome slot="footer" />
      </div>

      <div data-slot="composer-hint">
        {/*
          Each hint is its own element, ranked (DESIGN §47).

          Two reasons. The row is a flex container, so as bare text every word
          and every `<kbd>` was a separate flex item with a gap between it and
          the next — the sentence came apart at "Enter | to | send" and then
          wrapped inside those items when space ran short. And whole phrases are
          what should disappear when the composer narrows: half a hint is worse
          than no hint. The ranks say which goes first, and the separators are
          drawn in CSS so hiding one leaves no orphaned dot.
        */}
        <span data-slot="hint-list">
          <Show
            when={listening()}
            fallback={
              <Show
                when={openMenu() !== null}
                fallback={
                  <>
                    <span data-slot="hint" data-rank="1">
                      <kbd>Enter</kbd> to send
                    </span>
                    <span data-slot="hint" data-rank="2">
                      <kbd>/</kbd> for commands
                    </span>
                    <Show
                      when={state.memorySubjects.length > 0}
                      fallback={
                        <span data-slot="hint" data-rank="3">
                          <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
                        </span>
                      }
                    >
                      <span data-slot="hint" data-rank="3">
                        <kbd>@</kbd> for memory
                      </span>
                    </Show>
                  </>
                }
              >
                <>
                  <span data-slot="hint" data-rank="1">
                    <kbd>↑</kbd> <kbd>↓</kbd> to choose
                  </span>
                  <span data-slot="hint" data-rank="2">
                    <kbd>Tab</kbd> to complete
                  </span>
                  <span data-slot="hint" data-rank="3">
                    <kbd>Esc</kbd> to dismiss
                  </span>
                </>
              </Show>
            }
          >
            <span data-slot="hint" data-rank="1">
              Listening… speak, then press <kbd>Enter</kbd> to send.
            </span>
          </Show>
        </span>

        <ContextMeter />
      </div>
    </div>
  );
}

/**
 * How full the context is, as a ring under the input (DESIGN §54).
 *
 * Ambient rather than alarming: a small dial that fills as the conversation
 * grows, sitting with the other hints below the box rather than among the
 * controls, where it would compete with the model and the send button. Clicking
 * it opens the numbers behind it and the two things worth doing about them.
 *
 * Nothing is drawn while Pi cannot say — the window right after a compaction,
 * before the next reply — because a ring at zero would read as an empty context
 * rather than an unknown one.
 */
function ContextMeter() {
  const [open, setOpen] = createSignal(false);

  const usage = () => (state.activeSessionId ? state.contextUsage[state.activeSessionId] : null);
  const percent = () => usage()?.percent ?? null;
  const level = (value: number) => (value >= 85 ? "high" : value >= 70 ? "warn" : "normal");

  // Circumference of an r=6 circle, so `stroke-dasharray` can be read as a
  // percentage directly.
  const RING = 2 * Math.PI * 6;

  let host: HTMLDivElement | undefined;
  onMount(() => {
    const dismiss = (event: MouseEvent) => {
      if (host && !host.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss));
  });

  return (
    /* `percent() !== null`, not `percent()`: zero is a real reading and a falsy
       one, and testing the number directly hid the dial on an empty context. */
    <Show when={percent() !== null ? percent() : null}>
      {(value) => (
        <div data-slot="context-meter" ref={host}>
          <button
            type="button"
            data-slot="context-dial"
            data-level={level(value())}
            aria-label={`Context ${Math.round(value())}% full`}
            aria-expanded={open()}
            onClick={() => setOpen((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="6" fill="none" stroke-width="2" data-slot="dial-track" />
              <circle
                cx="7"
                cy="7"
                r="6"
                fill="none"
                stroke-width="2"
                stroke-linecap="round"
                data-slot="dial-fill"
                /* Starts at twelve o'clock and fills clockwise. */
                transform="rotate(-90 7 7)"
                stroke-dasharray={`${(Math.min(value(), 100) / 100) * RING} ${RING}`}
              />
            </svg>
            {Math.round(value())}%
          </button>

          {/* Anchored above the dial on every size. It is four lines and two
              controls — a sheet for that is more ceremony than content — so on
              a phone it stays a popup and is simply held inside the viewport. */}
          <Show when={open()}>
            <div data-slot="context-details">
              <div data-slot="context-figure">
                <strong>{formatTokens(usage()?.tokens ?? 0)}</strong> of{" "}
                {formatTokens(usage()?.contextWindow ?? 0)} tokens
              </div>
              <p data-slot="field-hint">
                Compacting summarises the earlier part of the conversation and drops what the summary
                replaces. Pi does it on its own as the context fills.
              </p>
              <Switch
                checked={state.autoCompaction}
                onChange={(enabled) => void setAutoCompaction(enabled)}
                label="Compact automatically"
              />
              <Button
                size="small"
                variant="outline"
                onClick={() => {
                  compactSession();
                  setOpen(false);
                }}
              >
                Compact now
              </Button>
            </div>
          </Show>

        </div>
      )}
    </Show>
  );
}

/** Token counts read at a glance rather than counted digit by digit. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}
