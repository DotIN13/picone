import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { ChatItem } from "@picone/protocol";
import {
  activeCapabilities,
  forkAt,
  loadEarlier,
  openFile,
  rewindTo,
  sessionSummary,
  state,
  surfaceOf,
  transcriptOf,
} from "../store.ts";
import { Markdown } from "./Markdown.tsx";
import { MentionText } from "./MentionText.tsx";
import { ToolCallView } from "./ToolCallView.tsx";
import { AskCard } from "./AskCard.tsx";
import { PermissionCard } from "./PermissionCard.tsx";
import { Icon } from "./ui/icon.tsx";
import { AgentMark } from "./ui/agent-marks.tsx";
import { Spinner, Tag } from "./ui/primitives.tsx";

export function ChatTab(props: { sessionId: string }) {
  let scroller: HTMLDivElement | undefined;
  let inner: HTMLDivElement | undefined;
  let bottom: HTMLDivElement | undefined;

  /*
   * Following the bottom.
   *
   * One question decides it: is the end of the transcript on screen? A sentinel
   * element after the last row and an IntersectionObserver watching it answer
   * that, which makes following a *position* rather than a gesture we have to
   * catch.
   *
   * Catching gestures is what this used to do — wheel, touch, arrow keys — and
   * it missed every other way to leave the bottom: a scrollbar drag, a
   * selection dragged upwards, find-in-page, an anchor click. Worse, a wheel
   * tick inside a tool-output box, which never moved the transcript at all,
   * counted as leaving it. Asking where the end is instead gets all of those
   * right without naming any of them.
   *
   * The same question answered the other way brings following back, so the end
   * arriving under a still reader — a tool call collapsing above, say — now
   * re-attaches too. That is the one thing the old rule did better, and it is
   * the price of a mechanism with one input instead of five.
   */
  /**
   * How close to the end counts as being at it, as the observer's bottom
   * margin. Generous on purpose: re-attaching only on a perfect landing means
   * chasing a moving target while an answer streams in.
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

  let following = true;
  /** Last position we set ourselves, so a scroll we did not cause is visible. */
  let ownTop = 0;

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
   *
   * Computed per row rather than into a list of `{item, stamp}` pairs, which is
   * what this used to be. `<For>` keys on reference, so a list of fresh wrapper
   * objects made every row new on every recompute — and a recompute happens on
   * every streamed delta. Each row was torn down and rebuilt several times a
   * second, which took any state inside it with it: an open tool-call dropdown
   * closed itself the moment the agent did anything.
   */
  const stampFor = (item: ChatItem, index: number) => separatorFor(shown()[index - 1], item);

  /** True while a page is on its way from the server, so we ask once. */
  let fetching = false;

  /**
   * Anything older to reach for, in memory or in the database.
   *
   * An empty transcript has nothing before it by definition, and saying so here
   * covers the moment before the first snapshot lands — otherwise a new session
   * opens offering to fetch messages it has never had.
   */
  const hasEarlier = () =>
    items().length > 0 && (hidden() > 0 || state.moreHistory[props.sessionId] !== false);

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

  /**
   * Put the end back on screen.
   *
   * Scrolling the sentinel into view rather than assigning `scrollHeight` to
   * `scrollTop`: one primitive that lands on the last pixel of content without
   * this component doing the arithmetic, and it lands below the inner column's
   * bottom padding, which the arithmetic version used to eat.
   *
   * `instant` because a streaming turn re-pins many times a second, and a
   * smooth scroll restarted every frame is an animation that never arrives.
   */
  const stick = () => {
    if (!following || !bottom) return;
    bottom.scrollIntoView({ block: "end", inline: "nearest", behavior: "instant" });
    ownTop = scroller?.scrollTop ?? 0;
  };

  /*
   * Two observers, one question each: the sentinel says whether the end is on
   * screen, the boxes say when something changed shape. Both are needed — a
   * streamed delta changes neither the message count nor, once we have
   * corrected for it, where the sentinel sits.
   *
   * This replaced a `requestAnimationFrame` loop that wrote `scrollTop` on
   * every frame of every turn. It cost a forced layout per frame per working
   * tab, hidden ones included, and it made the bottom impossible to leave by
   * any means slower than a wheel tick: it restored the position before the
   * scroll event from a scrollbar drag had even been dispatched.
   *
   * The correction has to land in the same frame as the growth, and it does:
   * resize observations are delivered before intersections are computed, so the
   * sentinel is measured after we have already followed. The guard below is
   * what covers us if that order ever fails.
   */
  onMount(() => {
    stick();
    if (!scroller || !bottom || !inner) return;

    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          const latest = entries[entries.length - 1];
          if (!latest || !scroller) return;

          // A background tab is `display: none` and has no box for anything to
          // be inside of, so every target in it reads as off screen. Ignoring
          // that is what leaves a tab still following when it comes back.
          if (scroller.clientHeight === 0) return;

          if (latest.isIntersecting) {
            following = true;
            return;
          }

          /*
           * Off the end — but only the reader gets to stop the following. Still
           * being where we last put ourselves means the end went away
           * underneath us rather than us leaving it, so we go after it instead.
           * One growth we were told about too late should not quietly end a
           * turn's worth of following.
           */
          if (following && scroller.scrollTop >= ownTop - 1) {
            stick();
            return;
          }

          following = false;
        },
        { root: scroller, rootMargin: `0px 0px ${NEAR_BOTTOM}px 0px`, threshold: 0 },
      );
      observer.observe(bottom);
      onCleanup(() => observer.disconnect());
    }

    if ("ResizeObserver" in window) {
      // The column, for content arriving. The viewport too, because a growing
      // composer or a shrinking window moves the end just as surely — and it is
      // the browser clamping `scrollTop` behind our back that would otherwise
      // leave `ownTop` describing a position which no longer exists.
      const observer = new ResizeObserver(() => stick());
      observer.observe(inner);
      observer.observe(scroller);
      onCleanup(() => observer.disconnect());
    }
  });

  /**
   * How far the end is from the viewport, right now.
   *
   * The one place that still measures rather than asking the observer, because
   * sending needs an answer in the same tick: scroll down and hit send in the
   * same frame and the observer has not spoken yet, which would leave your own
   * message off screen.
   */
  const gap = () => (scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : 0);

  /*
   * Sending starts following again, and only from near the bottom: send from
   * halfway up a long transcript and you stay where you were reading. Keyed on
   * the newest user message rather than on a callback from the composer, so a
   * comment (§19) or a voice turn re-arms it too.
   */
  createEffect((previous: string | undefined) => {
    const list = items();
    const latest = [...list].reverse().find((item) => item.kind === "user")?.id;
    if (latest && latest !== previous && gap() <= NEAR_BOTTOM) {
      following = true;
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
      /*
       * Nothing about following is decided here any more; the observers own
       * that. All this watches for is the reader nearing the top of what is
       * rendered, which is a question about distance rather than about
       * visibility — an observer would announce the top once on the way in and
       * then say nothing at all while the reader kept climbing.
       */
      onScroll={() => {
        if (scroller && scroller.scrollTop < LOAD_MORE_AT && hasEarlier()) showEarlier();
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

        {/* Keyed on the item itself, so a row survives everything but its own
            removal. `index` is a signal here — the stamp follows a message that
            shifts position as history pages in. */}
        <For each={shown()}>
          {(item, index) => {
            const stamp = createMemo(() => stampFor(item, index()));
            return (
              <>
                <Show when={stamp()}>{(text) => <div data-slot="chat-time">{text()}</div>}</Show>
                <ChatRow item={item} />
              </>
            );
          }}
        </For>

        {/*
          The tail keeps its height whether or not the agent is working. It used
          to be the indicator itself, so finishing a turn removed a row and the
          whole transcript slid down by its height — a jump at the exact moment
          the reader starts reading the answer.
        */}
        <div data-slot="chat-tail">
          {/*
            An extension can rename this row, hide it, or replace the spinner
            (§55). `frames` of one is a static glyph and `[]` means no indicator
            at all, which is why an empty array is not the same as undefined.
          */}
          <Show when={working() && !surfaceOf(props.sessionId).workingHidden}>
            <div data-slot="chat-working">
              <Show
                when={surfaceOf(props.sessionId).workingFrames}
                fallback={<AgentMark agent={sessionSummary(props.sessionId)?.agent} size={15} busy />}
              >
                {(frames) => <Show when={frames().length > 0}>
                  <span data-slot="chat-working-frame">{frames()[0]}</span>
                </Show>}
              </Show>
              {surfaceOf(props.sessionId).workingMessage ??
                `${agentState() === "tool" ? "running tools" : "working"}…`}
            </div>
          </Show>
        </div>
      </div>

      {/*
        The end of the transcript, as something that can be observed and
        scrolled to. Outside the inner column on purpose: scrolling it into view
        then lands below that column's bottom padding rather than on the last
        row, so following the bottom shows the bottom.
      */}
      <div data-slot="chat-bottom" ref={bottom} aria-hidden="true" />
    </div>
  );
}

function ChatRow(props: { item: ChatItem }) {
  // What this session's agent can do with a past message (§58).
  const canRewind = () => activeCapabilities()?.rewind ?? true;
  const canFork = () => activeCapabilities()?.fork ?? true;

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

            {/* Only where the agent has a node to go back to (§53). Messages
                from before the session tree was tracked have no entry id, and
                an agent may not do this at all (§58) — an affordance that
                cannot work is worse than none. */}
            <Show when={item().entryId && (canRewind() || canFork())}>
              <div data-slot="msg-actions">
                <Show when={canRewind()}>
                  <button
                    type="button"
                    data-slot="msg-action"
                    title="Go back to just before this message, in this session"
                    onClick={() => rewindTo(item().id)}
                  >
                    <Icon name="rewind" size={11} />
                    Rewind
                  </button>
                </Show>
                <Show when={canFork()}>
                  <button
                    type="button"
                    data-slot="msg-action"
                    title="Continue from here in a new session, leaving this one as it is"
                    onClick={() => void forkAt(item().id)}
                  >
                    <Icon name="git-branch" size={11} />
                    Fork
                  </button>
                </Show>
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

      <Match when={props.item.kind === "ask" ? props.item : null}>
        {(item) => <AskCard ask={item().ask} answer={item().answer} />}
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
