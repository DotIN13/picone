import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { SlashCommand } from "@picone/protocol";
import {
  abort,
  activeSessionState,
  closeTab,
  consumeEditorPatch,
  newSession,
  reportEditorText,
  sendPrompt,
  setSettingsOpen,
  state,
  toggleColorScheme,
  toggleSidebar,
  widgetsAt,
} from "../store.ts";
import { Dictation, isSpeechInputSupported, stopSpeaking } from "../voice/speech.ts";
import { Icon } from "./ui/icon.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { SlashMenu, filterCommands } from "./SlashMenu.tsx";

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
];

export function Composer() {
  const [text, setText] = createSignal("");
  const [listening, setListening] = createSignal(false);
  const [voiceError, setVoiceError] = createSignal<string | null>(null);
  const [menuIndex, setMenuIndex] = createSignal(0);

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

  createEffect(() => {
    // Reset the highlight whenever the candidate list changes.
    matches();
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
    const list = matches();
    if (list.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMenuIndex((i) => (i + 1) % list.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMenuIndex((i) => (i - 1 + list.length) % list.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        const command = list[menuIndex()];
        if (command) {
          event.preventDefault();
          pickCommand(command);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setText("");
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
        <ExtensionWidgets placement="aboveEditor" />

        <SlashMenu
          commands={matches()}
          query={slashQuery() ?? ""}
          activeIndex={menuIndex()}
          onHover={setMenuIndex}
          onPick={pickCommand}
        />

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
            onInput={(event) => setText(event.currentTarget.value)}
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

            <Show
              when={busy()}
              fallback={
                <button
                  type="button"
                  data-slot="composer-send"
                  disabled={!text().trim() || disabled()}
                  aria-label="Send"
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
      </div>

      <div data-slot="composer-hint">
        <Show
          when={listening()}
          fallback={
            <Show
              when={matches().length > 0}
              fallback={
                <>
                  <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line · <kbd>/</kbd> for commands
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
      </div>
    </div>
  );
}
