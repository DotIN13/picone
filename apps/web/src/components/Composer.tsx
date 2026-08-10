import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { MemorySubject, SlashCommand } from "@picone/protocol";
import {
  abort,
  activeSessionState,
  compactSession,
  setAutoCompaction,
  closeTab,
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
import { Dictation, isSpeechInputSupported, stopSpeaking } from "../voice/speech.ts";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Switch } from "./ui/primitives.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { SlashMenu, filterCommands } from "./SlashMenu.tsx";
import { MentionMenu, filterSubjects, mentionQueryAt } from "./MentionMenu.tsx";

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
      {(text) => (
        <pre data-slot="ext-chrome" data-chrome={props.slot}>
          {text().join("\n")}
        </pre>
      )}
    </Show>
  );
}

/** Line blocks an extension pushed via `setWidget`, rendered as monospace. */
function ExtensionWidgets(props: { placement: "aboveEditor" | "belowEditor" }) {
  const widgets = () => widgetsAt(props.placement);
  return (
    <Show when={widgets().length > 0}>
      <div data-slot="ext-widgets" data-placement={props.placement}>
        <For each={widgets()}>
          {(lines) => (
            <pre data-slot="ext-widget">{lines.join("\n")}</pre>
          )}
        </For>
      </div>
    </Show>
  );
}

/** Commands handled in the browser; they never reach Pi. */
const APP_COMMANDS: SlashCommand[] = [
  { name: "new", description: "Start a new session in a new tab", source: "app" },
  { name: "close", description: "Close the current tab", source: "app" },
  { name: "settings", description: "Open workspace settings", source: "app" },
  { name: "theme", description: "Toggle light / dark theme", source: "app" },
  { name: "sidebar", description: "Show or hide the sidebar", source: "app" },
  { name: "compact", description: "Summarise the conversation so far to free context", source: "app" },
];

export function Composer() {
  const [text, setText] = createSignal("");
  const [listening, setListening] = createSignal(false);
  const [voiceError, setVoiceError] = createSignal<string | null>(null);
  const [menuIndex, setMenuIndex] = createSignal(0);
  /** Mentions happen mid-sentence, so the menu keys off the caret, not the field. */
  const [caret, setCaret] = createSignal(0);
  /** Offset of an `@` whose menu was dismissed with Escape. */
  const [dismissed, setDismissed] = createSignal<number | null>(null);

  const dictation = new Dictation();
  let baseText = "";
  let textarea: HTMLTextAreaElement | undefined;

  const busy = () => activeSessionState() !== "idle";
  const disabled = () => state.activeSessionId === null;

  /** The slash menu is open while the text is a single `/token` with no space. */
  const slashQuery = createMemo(() => {
    const value = text();
    if (!value.startsWith("/")) return null;
    const token = value.slice(1);
    return /\s/.test(token) ? null : token;
  });

  const commands = createMemo(() => {
    const sessionId = state.activeSessionId;
    const piCommands = sessionId ? (state.commands[sessionId] ?? []) : [];
    return [...APP_COMMANDS, ...piCommands];
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

  createEffect(() => {
    text();
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  });

  // Mirror the composer to the server so `getEditorText()` returns something
  // real. Debounced — extensions read it occasionally, not per keystroke.
  let mirror: number | undefined;
  createEffect(() => {
    const value = text();
    if (mirror) window.clearTimeout(mirror);
    mirror = window.setTimeout(() => reportEditorText(value), 200);
  });

  // An extension called setEditorText/pasteToEditor.
  createEffect(() => {
    const patch = state.editorPatch;
    if (!patch) return;
    setText(patch.text);
    consumeEditorPatch();
    textarea?.focus();
  });

  const runAppCommand = (name: string): boolean => {
    switch (name) {
      case "new":
        void newSession();
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
      default:
        return false;
    }
  };

  const pickCommand = (command: SlashCommand) => {
    if (command.source === "app") {
      runAppCommand(command.name);
      setText("");
      return;
    }
    // Pi expands prompt templates and runs extension commands itself, so the
    // composer only has to complete the token and let the user add arguments.
    setText(`/${command.name} `);
    textarea?.focus();
  };

  /**
   * Complete the token in place. Only text goes in — the pointer the agent
   * receives is assembled server-side when the turn is sent, so a mention
   * survives being edited, copied, or reloaded (§52).
   */
  const pickSubject = (subject: MemorySubject) => {
    const active = mention();
    if (!active) return;
    const value = text();
    const inserted = `@${subject.slug} `;
    const next = value.slice(0, active.start) + inserted + value.slice(caret());
    const at = active.start + inserted.length;
    setText(next);
    setCaret(at);
    textarea?.focus();
    // The caret has to be placed after Solid has written the new value.
    queueMicrotask(() => textarea?.setSelectionRange(at, at));
  };

  const submit = (source: "chat" | "voice" = "chat") => {
    const value = text().trim();
    if (!value) return;

    const appCommand = value.startsWith("/") ? APP_COMMANDS.find((c) => `/${c.name}` === value) : undefined;
    if (appCommand) {
      runAppCommand(appCommand.name);
      setText("");
      return;
    }

    // During an active run this becomes steering server-side (DESIGN §28).
    sendPrompt(value, source);
    setText("");
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
      onTranscript: (transcript) => setText(`${baseText}${transcript}`),
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
        if (menu === "slash") setText("");
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

        <div data-slot="composer-box" data-listening={listening() ? "" : undefined}>
          <textarea
            ref={textarea}
            data-slot="composer-input"
            rows={1}
            disabled={disabled()}
            value={text()}
            placeholder={
              disabled() ? "Open a session to start" : busy() ? "Steer the agent…" : "Ask anything, or / for commands"
            }
            onInput={(event) => {
              setText(event.currentTarget.value);
              setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
            }}
            onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
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
        <Show
          when={listening()}
          fallback={
            <Show
              when={openMenu() !== null}
              fallback={
                <>
                  <kbd>Enter</kbd> to send · <kbd>/</kbd> for commands ·{" "}
                  <Show when={state.memorySubjects.length > 0} fallback={<><kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</>}>
                    <kbd>@</kbd> for memory
                  </Show>
                </>
              }
            >
              <>
                <kbd>↑</kbd> <kbd>↓</kbd> to choose · <kbd>Tab</kbd> to complete · <kbd>Esc</kbd> to dismiss
              </>
            </Show>
          }
        >
          Listening… speak, then press <kbd>Enter</kbd> to send.
        </Show>

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
