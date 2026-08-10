import { For, Match, Show, Switch, createEffect, onMount } from "solid-js";
import type { ChatItem } from "@picone/protocol";
import { forkAt, openFile, rewindTo, state, transcriptOf } from "../store.ts";
import { Markdown } from "./Markdown.tsx";
import { MentionText } from "./MentionText.tsx";
import { ToolCallView } from "./ToolCallView.tsx";
import { PermissionCard } from "./PermissionCard.tsx";
import { Icon } from "./ui/icon.tsx";
import { Spinner, Tag } from "./ui/primitives.tsx";

export function ChatTab(props: { sessionId: string }) {
  let scroller: HTMLDivElement | undefined;
  let bottom: HTMLDivElement | undefined;
  let pinned = true;

  const items = () => transcriptOf(props.sessionId);
  const agentState = () => state.agentStates[props.sessionId] ?? "idle";

  const scrollToBottom = () => {
    if (pinned) bottom?.scrollIntoView({ block: "end" });
  };

  onMount(scrollToBottom);
  createEffect(() => {
    items().length;
    agentState();
    queueMicrotask(scrollToBottom);
  });

  return (
    <div
      data-slot="chat"
      ref={scroller}
      onScroll={() => {
        if (!scroller) return;
        pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      }}
    >
      <div data-slot="chat-inner">
        <Show when={items().length === 0}>
          <div data-slot="chat-empty">
            <div data-slot="chat-empty-mark">
              <Icon name="sparkle" size={18} />
            </div>
            {/* An invitation rather than instructions. The second line names
                the three ways in without explaining any of them. */}
            <p class="text-[calc(14px*var(--font-scale))] font-[530]">Ask anything about this workspace.</p>
            <p class="text-v2-text-text-muted">Your ideas in text, voice, comments, we got them all covered.</p>
          </div>
        </Show>

        <For each={items()}>{(item) => <ChatRow item={item} />}</For>

        <Show when={agentState() !== "idle" && agentState() !== "waiting_permission"}>
          <div data-slot="chat-working">
            <Spinner />
            {agentState() === "tool" ? "running tools" : "working"}…
          </div>
        </Show>

        <div ref={bottom} />
      </div>
    </div>
  );
}

function ChatRow(props: { item: ChatItem }) {
  return (
    <Switch>
      <Match when={props.item.kind === "user" ? props.item : null}>
        {(item) => (
          <div data-slot="msg-group" data-role="user">
            {/* The bubble and its actions are siblings: the actions belong
                under the message, not inside it, so they never paint on its
                background or widen it when the pointer passes over. */}
            <div data-slot="msg" data-role="user" data-source={item().source ?? "chat"}>
              <Show when={item().source === "comment" || item().source === "voice"}>
                <div data-slot="msg-tag">
                  <Icon name={item().source === "voice" ? "mic" : "comment"} size={11} />
                  {item().source === "voice" ? "voice" : "file comment"}
                </div>
              </Show>
              <div data-slot="msg-body">
                <MentionText text={item().text} />
              </div>
            </div>

            {/* Only where Pi has a node to go back to (§53). Messages from
                before the session tree was tracked have no entry id, and an
                affordance that cannot work is worse than none. */}
            <Show when={item().entryId}>
              <div data-slot="msg-actions">
                <button
                  type="button"
                  data-slot="msg-action"
                  title="Go back to just before this message, in this session"
                  onClick={() => rewindTo(item().id)}
                >
                  <Icon name="rewind" size={11} />
                  Rewind
                </button>
                <button
                  type="button"
                  data-slot="msg-action"
                  title="Continue from here in a new session, leaving this one as it is"
                  onClick={() => void forkAt(item().id)}
                >
                  <Icon name="git-branch" size={11} />
                  Fork
                </button>
              </div>
            </Show>
          </div>
        )}
      </Match>

      {/*
        An assistant turn with nothing in it gets no bubble. The turn is
        announced before its first token and only dropped once it ends, so a
        step that produces only tool calls would otherwise show an empty bubble
        for as long as the tool takes and then delete it — which is what made a
        transcript look like nothing was happening. `working…` already says the
        agent is busy; a blank bubble says it replied with nothing.
      */}
      <Match when={props.item.kind === "assistant" ? props.item : null}>
        {(item) => (
          <Show when={item().text.trim() || item().thinking}>
            <div data-slot="msg" data-role="assistant">
              <Show when={item().thinking}>
                {(thinking) => (
                  <details data-slot="thinking">
                    <summary>
                      <Icon name="sparkle" size={11} />
                      thinking
                    </summary>
                    <pre>{thinking()}</pre>
                  </details>
                )}
              </Show>
              <Markdown text={item().text} onOpenFile={(path) => void openFile(path)} />
            </div>
          </Show>
        )}
      </Match>

      <Match when={props.item.kind === "extension" ? props.item : null}>
        {(item) => (
          <div data-slot="ext-message-row">
            <div data-slot="ext-message-head">
              <Icon name="plug" size={12} />
              {item().customType}
            </div>
            <pre data-slot="ext-message-body">{item().text}</pre>
          </div>
        )}
      </Match>

      <Match when={props.item.kind === "tool" ? props.item : null}>
        {(item) => <ToolCallView toolCall={item().toolCall} />}
      </Match>

      <Match when={props.item.kind === "permission" ? props.item : null}>
        {(item) => <PermissionCard request={item().request} decision={item().decision} />}
      </Match>

      <Match when={props.item.kind === "notice" ? props.item : null}>
        {(item) => (
          <div data-slot="chat-notice">
            <Tag tone={item().level === "error" ? "danger" : item().level === "warn" ? "warning" : "info"}>
              {item().level}
            </Tag>
            <span>{item().text}</span>
          </div>
        )}
      </Match>
    </Switch>
  );
}
