import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { ChatItem } from "@picone/protocol";
import { forkAt, loadEarlier, openFile, rewindTo, state, transcriptOf } from "../store.ts";
import { Markdown } from "./Markdown.tsx";
import { MentionText } from "./MentionText.tsx";
import { ToolCallView } from "./ToolCallView.tsx";
import { PermissionCard } from "./PermissionCard.tsx";
import { Icon } from "./ui/icon.tsx";
import { Spinner, Tag } from "./ui/primitives.tsx";

export function ChatTab(props: { sessionId: string }) {
  let scroller: HTMLDivElement | undefined;
  let inner: HTMLDivElement | undefined;

  /*
   * Following the bottom, and the rules for stopping and starting again.
   *
   * Off the moment you scroll up. Back on when you scroll back down towards the
   * bottom, or when you send something from near it. What it never does is
   * re-attach on its own: every way back requires a deliberate move downwards.
   */
  /**
   * How close to the bottom counts as being at it — for sending, and for
   * scrolling back down. One number for both, because they are the same
   * judgement: near enough that you meant to be following.
   *
   * Generous on purpose. Re-attaching only on a perfect landing means chasing a
   * moving target while an answer streams in; what matters is the *direction*
   * you moved, and moving down is unambiguous.
   */
  const NEAR_BOTTOM = 120;

  /*
   * How much of a long transcript is in the DOM (DESIGN §14).
   *
   * Rows are rendered from the end. Scrolling towards the top of what is
   * rendered pulls in another page and holds the reader's position; coming back
   * to the bottom throws the extra away again, so a session that has been open
   * all day costs the same as one just opened.
   *
   * Windowing from the tail rather than around the viewport, deliberately: a
   * true virtual list has to guess the height of what it is not showing, and
   * every one of those guesses lands on the scrollbar. Growing downwards from a
   * fixed end means no estimates, no spacers, and no jitter — the price is that
   * reaching far-back history takes a moment of scrolling rather than a drag of
   * the scrollbar.
   */
  const WINDOW = 60;
  const LOAD_MORE_AT = 800;

  let pinned = true;
  /** Last position we set ourselves, so a scroll we did not cause is visible. */
  let ownTop = 0;
  /** Where a touch drag started, to tell scrolling up from scrolling down. */
  let touchY: number | null = null;

  const [windowed, setWindowed] = createSignal(WINDOW);
  const items = () => transcriptOf(props.sessionId);
  /** The tail of the transcript that is actually rendered. */
  const shown = createMemo(() => {
    const all = items();
    const size = windowed();
    return all.length <= size ? all : all.slice(all.length - size);
  });
  const hidden = () => Math.max(0, items().length - shown().length);

  /**
   * Each rendered item, with the time marker that belongs above it.
   *
   * Not one per message: a stamp on every line is a column of noise nobody
   * reads. One when the conversation resumes after a gap, one when the day
   * changes, and one at the top of what is rendered so the window always says
   * where it starts.
   */
  const rows = createMemo(() => {
    const list = shown();
    return list.map((item, index) => ({ item, stamp: separatorFor(list[index - 1], item) }));
  });

  /** True while a page is on its way from the server, so we ask once. */
  let fetching = false;

  /** Anything older to reach for, in memory or in the database. */
  const hasEarlier = () => hidden() > 0 || state.moreHistory[props.sessionId] !== false;

  /**
   * Show another page, keeping what the reader is looking at exactly where it
   * is: measure, grow, and hand the added height straight back to `scrollTop`.
   *
   * Two sources, in order. The window is widened first, because those messages
   * are already here; only when it has caught up with what was loaded does this
   * go to the database, which holds everything older (§14).
   */
  const showEarlier = () => {
    if (!scroller) return;

    if (hidden() > 0) {
      const before = scroller.scrollHeight;
      setWindowed((size) => size + WINDOW);
      scroller.scrollTop += scroller.scrollHeight - before;
      ownTop = scroller.scrollTop;
      return;
    }

    if (fetching || state.moreHistory[props.sessionId] === false) return;
    fetching = true;
    const before = scroller.scrollHeight;

    void loadEarlier(props.sessionId)
      .then((added) => {
        if (!scroller || added === 0) return;
        // The window has to grow with the fetch, or the new page is loaded and
        // immediately hidden again.
        setWindowed((size) => size + added);
        scroller.scrollTop += scroller.scrollHeight - before;
        ownTop = scroller.scrollTop;
      })
      .finally(() => {
        fetching = false;
      });
  };
  const agentState = () => state.agentStates[props.sessionId] ?? "idle";
  const working = () => agentState() !== "idle" && agentState() !== "waiting_permission";

  const gap = () => (scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : 0);

  const stick = () => {
    if (!pinned || !scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    ownTop = scroller.scrollTop;
  };

  /**
   * Let go, immediately.
   *
   * Called from the gestures themselves rather than from `scroll`, because the
   * frame loop below writes `scrollTop` every frame: a wheel tick would be
   * undone before the scroll event it produced had been handled, and the view
   * would refuse to move at all.
   */
  const release = () => {
    pinned = false;
  };

  /*
   * Following the bottom takes two mechanisms, because neither is enough.
   *
   * Watching `items().length` only fires when a message is *added*, and a
   * streaming message does not change the count — so the view stopped following
   * the moment an answer began. A resize observer is the obvious replacement
   * and is too coarse on its own: during a fast stream it delivered two
   * callbacks for an entire turn while the bottom drifted 140px away.
   *
   * So: a frame loop while the agent is working, which is exactly when the
   * transcript grows; and the observer for everything else — an image
   * finishing, a tool call expanding, the window changing shape.
   */
  onMount(() => {
    stick();
    if (!inner || !("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(() => stick());
    observer.observe(inner);
    onCleanup(() => observer.disconnect());
  });

  /*
   * One loop per turn, doing both halves of the job.
   *
   * Pinned, it follows. Released, it watches for the reader heading back down
   * — and that check happens here rather than in the `scroll` handler, because
   * a scroll event is dispatched at the end of the frame and by then a
   * streaming transcript has grown underneath it. Measured: a scroll that
   * landed exactly on the bottom was already ~100px above it by the time the
   * handler ran. A frame is the shortest interval available, so what it
   * measures is barely stale.
   */
  createEffect(() => {
    if (!working()) return;
    let previousTop = scroller?.scrollTop ?? 0;

    let frame = requestAnimationFrame(function follow() {
      if (scroller) {
        if (pinned) {
          stick();
        } else {
          const top = scroller.scrollTop;
          const distance = scroller.scrollHeight - scroller.clientHeight - top;
          if (top > previousTop && distance <= NEAR_BOTTOM) pinned = true;
          previousTop = top;
        }
      }
      frame = requestAnimationFrame(follow);
    });

    onCleanup(() => cancelAnimationFrame(frame));
  });

  /*
   * Sending is the only thing that starts following again, and only from near
   * the bottom: send from halfway up a long transcript and you stay where you
   * were reading. Keyed on the newest user message rather than on a callback
   * from the composer, so a comment (§19) or a voice turn re-arms it too.
   */
  createEffect((previous: string | undefined) => {
    const list = items();
    const latest = [...list].reverse().find((item) => item.kind === "user")?.id;
    if (latest && latest !== previous && gap() <= NEAR_BOTTOM) {
      pinned = true;
      // Back at the end, so the pages pulled in earlier are far off screen and
      // can go. Without this a long-lived session only ever grows.
      setWindowed(WINDOW);
      queueMicrotask(stick);
    }
    return latest;
  });

  return (
    <div
      data-slot="chat"
      ref={scroller}
      /* Wheel and trackpad: any upward tick is a decision to stop following. */
      onWheel={(event) => {
        if (event.deltaY < 0) release();
      }}
      /* Touch: dragging the content down is scrolling up. */
      onTouchStart={(event) => {
        touchY = event.touches[0]?.clientY ?? null;
      }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY ?? null;
        if (touchY !== null && y !== null && y > touchY + 2) release();
        touchY = y;
      }}
      onKeyDown={(event) => {
        if (["ArrowUp", "PageUp", "Home"].includes(event.key)) release();
      }}
      /*
       * The backstop, for a scrollbar drag — which produces no wheel, no touch
       * and no key.
       *
       * A drop in `scrollTop` is only the reader if it also moved us off the
       * bottom. Content shrinking mid-turn — a tool call collapsing, a
       * streaming block re-rendering shorter — makes the browser clamp
       * `scrollTop` down all by itself, and reading that as a gesture unpinned
       * the view in the middle of its own answer.
       */
      onScroll={() => {
        if (!scroller) return;
        const top = scroller.scrollTop;
        const distance = scroller.scrollHeight - scroller.clientHeight - top;

        if (top < LOAD_MORE_AT && hasEarlier()) showEarlier();

        if (top < ownTop - 1 && distance > 1) {
          release();
        } else if (!pinned && top > ownTop && distance <= NEAR_BOTTOM) {
          // Back at the bottom while nothing is streaming, so the measurement
          // is trustworthy. During a turn the frame loop above does this.
          pinned = true;
        }
        ownTop = top;
      }}
    >
      <div data-slot="chat-inner" ref={inner}>
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

        {/* Everything older than the window, in one line rather than in the DOM. */}
        <Show when={hasEarlier()}>
          <button type="button" data-slot="chat-earlier" onClick={showEarlier}>
            {hidden() > 0 ? `${hidden()} earlier ${hidden() === 1 ? "message" : "messages"}` : "Earlier messages"}
          </button>
        </Show>

        <For each={rows()}>
          {(row) => (
            <>
              <Show when={row.stamp}>{(stamp) => <div data-slot="chat-time">{stamp()}</div>}</Show>
              <ChatRow item={row.item} />
            </>
          )}
        </For>

        {/*
          The tail keeps its height whether or not the agent is working. It used
          to be the indicator itself, so finishing a turn removed a row and the
          whole transcript slid down by its height — a jump at the exact moment
          the reader starts reading the answer.
        */}
        <div data-slot="chat-tail">
          <Show when={working()}>
            <div data-slot="chat-working">
              <Spinner />
              {agentState() === "tool" ? "running tools" : "working"}…
            </div>
          </Show>
        </div>
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

/**
 * When the conversation resumed, shown above the message that resumed it
 * (DESIGN §14).
 *
 * A separator earns its place by marking a *gap* — half an hour of silence, or
 * a new day. The first rendered message always gets one, because with a
 * windowed transcript the top of the view is an arbitrary point in history and
 * should say when it is.
 */
const RESUMED_AFTER_MS = 30 * 60_000;

function separatorFor(previous: ChatItem | undefined, item: ChatItem): string | null {
  const at = new Date(item.at);
  if (Number.isNaN(at.getTime())) return null;
  if (!previous) return whenLabel(at);

  const before = new Date(previous.at);
  if (Number.isNaN(before.getTime())) return null;
  if (at.toDateString() !== before.toDateString()) return whenLabel(at);
  return at.getTime() - before.getTime() >= RESUMED_AFTER_MS ? whenLabel(at) : null;
}

function whenLabel(at: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  if (at.toDateString() === today.toDateString()) return time;

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;

  const sameYear = at.getFullYear() === today.getFullYear();
  const date = at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${date} · ${time}`;
}
