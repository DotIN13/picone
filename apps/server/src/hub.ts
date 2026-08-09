import type { WebSocket } from "ws";
import type { AgentEvent, ServerFrame } from "@picone/protocol";

/**
 * Fan-out to every connected browser tab. Picone is a single-user local app, so
 * there is no per-client filtering beyond the session id carried in the frame.
 */
export class Hub {
  private readonly clients = new Set<WebSocket>();

  add(socket: WebSocket): void {
    this.clients.add(socket);
  }

  remove(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  get size(): number {
    return this.clients.size;
  }

  publish(sessionId: string | null, event: AgentEvent): void {
    const payload = JSON.stringify({ sessionId, event } satisfies ServerFrame);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  send(socket: WebSocket, sessionId: string | null, event: AgentEvent): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ sessionId, event } satisfies ServerFrame));
    }
  }
}
