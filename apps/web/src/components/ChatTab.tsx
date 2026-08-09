import { For, Match, Show, Switch, createEffect, onMount } from "solid-js";
import type { ChatItem } from "@picone/protocol";
import { openFile, state, transcriptOf } from "../store.ts";
import { Markdown } from "./Markdown.tsx";
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
            <p class="text-[14px] font-[530]">Ask anything about this workspace.</p>
            <p class="text-v2-text-text-muted">
              Open a file from the sidebar, select text, and leave a comment — it goes straight to the agent.
            </p>
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
          <div data-slot="msg" data-role="user" data-source={item().source ?? "chat"}>
            <Show when={item().source === "comment" || item().source === "voice"}>
              <div data-slot="msg-tag">
                <Icon name={item().source === "voice" ? "mic" : "comment"} size={11} />
                {item().source === "voice" ? "voice" : "file comment"}
              </div>
            </Show>
            <div data-slot="msg-body">{item().text}</div>
          </div>
        )}
      </Match>

      <Match when={props.item.kind === "assistant" ? props.item : null}>
        {(item) => (
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
