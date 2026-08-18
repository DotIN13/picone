import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage } from "@picone/protocol";
import type { App } from "./app.ts";
import { resolveWithinRoots } from "./util/paths.ts";

/** How often to check that a client is still on the other end of its socket. */
const KEEPALIVE = 15_000;

/**
 * One socket carries everything for the active session (DESIGN §31).
 * The path is `/ws` rather than `/sessions/:id/events` because the server owns
 * which session is active; frames carry the session id.
 */
export function attachWebSocket(server: Server, app: App): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  // `ws` re-emits the HTTP server's errors here, so a listen failure surfaces on
  // the WebSocketServer rather than on the server itself. Without this listener
  // it becomes an unhandled 'error' event and the stack buries the real cause.
  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") return; // reported by the http handler
    console.error("[picone] websocket error:", err);
  });

  wss.on("connection", (socket: WebSocket) => {
    app.hub.add(socket);
    const watched = new Set<string>();

    /*
     * The same problem from this end: a client whose network vanished never
     * closes its socket, so without asking, the hub keeps publishing to a
     * browser that is not there and holds file watches nobody is reading.
     *
     * This is the protocol's own ping, which a browser answers from its network
     * stack — no page code involved, so it keeps answering while the tab is
     * backgrounded or frozen, which an application-level ping does not. Missing
     * one answer is enough: they arrive in milliseconds when anything is there.
     */
    let answered = true;
    socket.on("pong", () => {
      answered = true;
    });
    const keepalive = setInterval(() => {
      if (!answered) {
        socket.terminate();
        return;
      }
      answered = false;
      socket.ping();
    }, KEEPALIVE);

    // Bring a fresh (or reconnected) client up to date immediately.
    const state = app.state();
    app.hub.send(socket, null, { type: "session.list", sessions: state.sessions, activeSessionId: state.activeSessionId });
    if (state.workspace) app.hub.send(socket, null, { type: "workspace.updated", workspace: state.workspace });
    app.hub.send(socket, null, { type: "mcp.state", servers: state.mcp });
    const active = app.activeSession();
    if (active) {
      app.hub.send(socket, active.id, active.snapshot());
      app.hub.send(socket, null, {
        type: "session.commands",
        sessionId: active.id,
        commands: active.commands(),
      });
    }

    socket.on("message", (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      /*
       * Answered here rather than in `handle`, because it is a question about
       * the connection and not about the app: whether this socket still reaches
       * the browser that opened it. Nothing else in the protocol replies, and a
       * browser cannot see protocol-level pongs, so it has to be able to ask.
       */
      if (message.type === "ping") {
        app.hub.send(socket, null, { type: "pong" });
        return;
      }
      void handle(app, message, watched).catch((err: Error) => {
        app.hub.send(socket, null, { type: "notice", text: err.message, level: "error" });
      });
    });

    socket.on("close", () => {
      clearInterval(keepalive);
      for (const path of watched) app.watcher.unwatch(path);
      watched.clear();
      app.hub.remove(socket);
    });

    socket.on("error", () => {
      app.hub.remove(socket);
    });
  });

  return wss;
}

async function handle(app: App, message: ClientMessage, watched: Set<string>): Promise<void> {
  switch (message.type) {
    case "prompt":
      await app.prompt(
        message.text,
        message.source ?? "chat",
        message.sessionId,
        message.display,
        message.commentIds,
      );
      break;

    case "steer":
      await app.steer(message.text, message.sessionId);
      break;

    case "abort":
      await app.abort(message.sessionId);
      break;

    case "permission_response":
      app.respondToPermission(message.requestId, message.decision);
      break;

    case "watch_file": {
      const abs = resolveWithinRoots(app.roots, message.path);
      if (!abs || watched.has(abs)) break;
      watched.add(abs);
      app.watcher.watch(abs);
      break;
    }

    case "unwatch_file": {
      const abs = resolveWithinRoots(app.roots, message.path);
      if (!abs || !watched.has(abs)) break;
      watched.delete(abs);
      app.watcher.unwatch(abs);
      break;
    }

    case "select_session":
      await app.selectSession(message.sessionId);
      break;

    case "new_session":
      await app.createSession(message.title ?? "New session", message.agent);
      break;

    case "rewind":
      await app.rewind(message.itemId, message.sessionId);
      break;

    case "ask_response":
      app.answerAsk(message.askId, message.answer);
      break;

    case "set_mode":
      await app.setMode(message.mode, message.sessionId);
      break;

    case "compact":
      await app.compact(message.sessionId);
      break;

    case "reload_session":
      await app.reloadSession(message.sessionId);
      break;

    case "session_stats":
      await app.reportStats(message.sessionId);
      break;

    case "session_export":
      await app.exportSession(message.sessionId);
      break;


    case "extension_ui_answer":
      app.answerExtensionUi(message.answer);
      break;

    case "extension_ui_key":
      app.keyExtensionUi(message.id, message.data);
      break;

    case "editor_text":
      app.setEditorText(message.text);
      break;

    case "ping":
      break;
  }
}
