import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ClientMessage, ServerFrame } from "@picone/protocol";

/**
 * A socket that can be dead without saying so, which is the whole point.
 *
 * `readyState` stays `OPEN` and `send` keeps accepting, exactly as a real one
 * does when its network has gone away — so a test can put the client in the
 * state that used to swallow a message.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  readonly sent: ClientMessage[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    made.push(this);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", {});
  }

  // --- what the other end does -----------------------------------------------

  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", {});
  }

  /** Answer the last ping, which is the only thing that proves it is alive. */
  pong(): void {
    this.deliver({ sessionId: null, event: { type: "pong" } });
  }

  deliver(frame: ServerFrame): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  of(type: string): ClientMessage[] {
    return this.sent.filter((message) => message.type === type);
  }

  private emit(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

let made: FakeSocket[] = [];

/** Enough of a browser for the client to run in, and no more. */
function browser(): void {
  made = [];
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.WebSocket = FakeSocket;
  globals.location = { protocol: "http:", host: "localhost:4318" };
  globals.window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: number) => clearInterval(id),
    addEventListener: () => {},
  };
  globals.document = { addEventListener: () => {}, visibilityState: "visible" };
}

const prompt = (text: string): ClientMessage => ({ type: "prompt", text, sessionId: "s1" });

async function client(t: TestContext) {
  browser();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { SocketClient, HEARTBEAT } = await import("./socket.ts");
  return { socket: new SocketClient(), HEARTBEAT };
}

test("a live socket carries a message straight out", async (t) => {
  const { socket, HEARTBEAT } = await client(t);
  socket.connect();
  const server = made[0]!;
  server.accept();

  t.mock.timers.tick(HEARTBEAT.every);
  assert.equal(server.of("ping").length, 1, "asked whether the server is there");
  server.pong();

  assert.equal(socket.send(prompt("hello")), true);
  assert.deepEqual(server.of("prompt"), [prompt("hello")]);
});

test("a socket that stopped answering keeps the message instead of eating it", async (t) => {
  const { socket, HEARTBEAT } = await client(t);
  socket.connect();
  const dead = made[0]!;
  dead.accept();
  dead.pong();

  // The network goes away. Nothing about the socket changes: still OPEN, still
  // accepting writes — this is the state that used to lose the message.
  t.mock.timers.tick(HEARTBEAT.every);
  assert.equal(dead.of("ping").length, 1);

  assert.equal(socket.send(prompt("does this survive?")), false, "held, not sent");
  assert.deepEqual(dead.of("prompt"), [], "nothing written into a socket we are unsure of");

  // The answer never comes, so the socket is given up on and replaced.
  t.mock.timers.tick(HEARTBEAT.every);
  assert.equal(dead.readyState, FakeSocket.CLOSED, "the dead one is closed rather than believed");
  assert.equal(made.length, 2, "and another is opened without waiting to be asked");

  const fresh = made[1]!;
  fresh.accept();
  assert.deepEqual(fresh.of("prompt"), [prompt("does this survive?")], "the message goes out on the new one");
});

test("an answer while a message waits sends it without a reconnect", async (t) => {
  const { socket, HEARTBEAT } = await client(t);
  socket.connect();
  const server = made[0]!;
  server.accept();

  t.mock.timers.tick(HEARTBEAT.every);
  // Sent in the moment between asking and hearing back: a slow link, not a dead
  // one, so it should not cost a reconnect.
  assert.equal(socket.send(prompt("in the gap")), false);
  server.pong();

  assert.deepEqual(server.of("prompt"), [prompt("in the gap")]);
  assert.equal(made.length, 1, "the socket was fine and was kept");
});

test("the composer's mirror does not pile up while offline", async (t) => {
  const { socket } = await client(t);
  // Never accepted, so everything is queued: a sentence being typed.
  socket.connect();
  const first = made[0]!;
  for (const text of ["h", "he", "hel", "hell", "hello"]) socket.send({ type: "editor_text", text });
  socket.send(prompt("and the message itself"));

  first.accept();
  assert.deepEqual(first.of("editor_text"), [{ type: "editor_text", text: "hello" }], "only the last one matters");
  assert.deepEqual(first.of("prompt"), [prompt("and the message itself")], "everything else is kept in order");
});

test("a socket given up on cannot report the disconnection it already caused", async (t) => {
  const { socket, HEARTBEAT } = await client(t);
  const statuses: boolean[] = [];
  socket.onStatus((connected) => statuses.push(connected));
  socket.connect();
  const dead = made[0]!;
  dead.accept();

  t.mock.timers.tick(HEARTBEAT.every);
  t.mock.timers.tick(HEARTBEAT.every);
  const fresh = made[1]!;
  fresh.accept();

  // Its `close` arrives late, as a real one does, and says nothing: by then the
  // replacement is up, and a stray `false` here would send the app looking for a
  // connection it already has.
  dead.close();
  assert.deepEqual(statuses, [true, false, true]);
});
