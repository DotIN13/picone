import type { ClientMessage, ServerFrame } from "@picone/protocol";

type FrameListener = (frame: ServerFrame) => void;
type StatusListener = (connected: boolean) => void;

/**
 * How often to ask the server whether it is still there, and how long to wait
 * for the answer before deciding it is not.
 *
 * A socket does not notice its network going away. Close the lid, or walk out of
 * range, and `readyState` stays `OPEN` until TCP gives up — which is minutes —
 * while every `send()` in the meantime is accepted and dropped on the floor
 * without an error. That was the bug this exists for: the page looked connected,
 * the message went nowhere, and only a reload put it right.
 *
 * The deadline is generous because it only has to beat TCP, and a link slow
 * enough to take four seconds over a two-byte reply is one worth reconnecting.
 */
const PING_EVERY = 5_000;
const PONG_DEADLINE = 4_000;

/**
 * One socket for the whole app (DESIGN §31), with reconnect.
 *
 * Two rules keep a message from vanishing into a socket that is no longer
 * attached to anything. Nothing is written through a socket that has not
 * answered recently — it is queued instead, and the socket is asked to prove
 * itself. And a queue goes out the moment proof arrives, which is either the
 * `pong` on the socket we had or the `open` on the one that replaces it.
 *
 * Exported as well as instantiated: the rules above are the part worth testing,
 * and a test should be able to make its own rather than reach into the one the
 * app is using.
 */
export class SocketClient {
  private socket: WebSocket | null = null;
  private readonly frameListeners = new Set<FrameListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private queue: ClientMessage[] = [];
  private retry = 0;
  private timer: number | null = null;
  private heartbeat: number | null = null;
  /** When we last asked, if we are still waiting for the answer. */
  private asked = 0;
  private listeningToTheDevice = false;

  connect(): void {
    this.listenToTheDevice();
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;

    /*
     * Every handler checks that this is still the current socket. A socket we
     * have given up on can open, or close, long after we stopped listening to
     * it, and its `close` would otherwise report a disconnection that has
     * already been recovered from — or schedule a second reconnect on top of
     * the one in flight.
     */
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.retry = 0;
      this.asked = 0;
      this.startBeating();
      for (const listener of this.statusListeners) listener(true);
      this.flush();
    });

    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.asked = 0;

      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }

      // Anything waiting has just been told the line is good.
      this.flush();

      // A pong is proof of life and nothing else; the app never sees one.
      if (frame.event.type === "pong") return;
      for (const listener of this.frameListeners) listener(frame);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopBeating();
      for (const listener of this.statusListeners) listener(false);
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => socket.close());
  }

  /**
   * Send now if the socket is answering, and otherwise hold it until one is.
   *
   * The return value says which happened, so a caller whose message the user is
   * watching for — a prompt — can say so rather than leaving them looking at a
   * transcript that never moves.
   */
  send(message: ClientMessage): boolean {
    if (this.socket?.readyState === WebSocket.OPEN && this.answering()) {
      this.socket.send(JSON.stringify(message));
      return true;
    }

    this.enqueue(message);
    if (this.socket?.readyState === WebSocket.OPEN) {
      // Open, and not answering. Ask, and if the asking has already timed out,
      // stop believing it.
      if (this.overdue()) this.giveUp();
      else this.ask();
    } else {
      this.connect();
    }
    return false;
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Nothing outstanding: either it has answered, or we have not asked yet. */
  private answering(): boolean {
    return this.asked === 0;
  }

  private overdue(): boolean {
    return this.asked !== 0 && Date.now() - this.asked > PONG_DEADLINE;
  }

  private ask(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.asked === 0) this.asked = Date.now();
    this.socket.send(JSON.stringify({ type: "ping" } satisfies ClientMessage));
  }

  /**
   * Queued, with one message of a kind where only the last one matters.
   *
   * The composer mirrors itself to the server as it is typed (§55), so a minute
   * offline with the keyboard busy would otherwise queue a few hundred versions
   * of a sentence, every one of them stale by the time it arrived.
   */
  private enqueue(message: ClientMessage): void {
    if (message.type === "editor_text") this.queue = this.queue.filter((m) => m.type !== "editor_text");
    this.queue.push(message);
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const queued = this.queue;
    this.queue = [];
    for (const message of queued) this.socket.send(JSON.stringify(message));
  }

  private startBeating(): void {
    this.stopBeating();
    this.heartbeat = window.setInterval(() => {
      if (this.overdue()) {
        this.giveUp();
        return;
      }
      this.ask();
    }, PING_EVERY);
  }

  private stopBeating(): void {
    if (this.heartbeat === null) return;
    window.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** This socket is not coming back. Drop it and start another immediately. */
  private giveUp(): void {
    const socket = this.socket;
    this.socket = null;
    this.stopBeating();
    socket?.close();
    for (const listener of this.statusListeners) listener(false);
    // Not a backoff case: the last one was up a moment ago, so the network is
    // the thing that changed, and it may well be back already.
    this.retry = 0;
    this.connect();
  }

  /**
   * What the device knows about its own network, which is sooner than we can
   * find out by asking (§31).
   *
   * `online` is a wifi coming back; becoming visible is a lid opening, where the
   * timers have been frozen and the socket may have died in its sleep. Neither
   * is treated as bad news on its own — the socket is asked, and it either
   * answers within the deadline or it does not.
   */
  private listenToTheDevice(): void {
    if (this.listeningToTheDevice) return;
    this.listeningToTheDevice = true;

    const wakeUp = () => {
      if (this.socket?.readyState === WebSocket.OPEN) this.ask();
      else if (this.socket?.readyState !== WebSocket.CONNECTING) {
        this.retry = 0;
        this.connect();
      }
    };

    window.addEventListener("online", wakeUp);
    window.addEventListener("focus", wakeUp);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") wakeUp();
    });
  }

  private scheduleReconnect(): void {
    if (this.timer !== null) return;
    const delay = Math.min(500 * 2 ** this.retry++, 8000);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}

export const socket = new SocketClient();

/** The heartbeat's timings, for tests that have to wait for them. */
export const HEARTBEAT = { every: PING_EVERY, deadline: PONG_DEADLINE };
