import type { ClientMessage, ServerFrame } from "@picone/protocol";

type FrameListener = (frame: ServerFrame) => void;
type StatusListener = (connected: boolean) => void;

/**
 * One socket for the whole app (DESIGN §31), with reconnect. Anything sent while
 * disconnected is queued so a brief drop does not lose the user's input.
 */
class SocketClient {
  private socket: WebSocket | null = null;
  private readonly frameListeners = new Set<FrameListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private queue: ClientMessage[] = [];
  private retry = 0;
  private timer: number | null = null;

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retry = 0;
      for (const listener of this.statusListeners) listener(true);
      const queued = this.queue;
      this.queue = [];
      for (const message of queued) this.send(message);
    });

    socket.addEventListener("message", (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      for (const listener of this.frameListeners) listener(frame);
    });

    socket.addEventListener("close", () => {
      for (const listener of this.statusListeners) listener(false);
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => socket.close());
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else {
      this.queue.push(message);
      this.connect();
    }
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
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
