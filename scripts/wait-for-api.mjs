import { connect } from "node:net";

/**
 * Hold the Vite dev server back until the API is listening.
 *
 * Vite is ready in under half a second; `tsx` takes a couple to compile and
 * boot. In that window the browser is served a page whose every request fails,
 * which fills the terminal with ECONNREFUSED and reads exactly like a crash.
 * Waiting costs a second or two and makes `npm run dev` mean what it says.
 */

const HOST = process.env.PICONE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PICONE_PORT ?? 4319);
const TIMEOUT_MS = 30_000;
const POLL_MS = 150;

const listening = () =>
  new Promise((resolve) => {
    const socket = connect({ host: HOST, port: PORT });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(POLL_MS, () => done(false));
  });

const started = Date.now();
let announced = false;

while (Date.now() - started < TIMEOUT_MS) {
  if (await listening()) process.exit(0);
  if (!announced) {
    // One line, not one per attempt — the point is to be quieter, not louder.
    process.stderr.write(`[picone] waiting for the API on ${HOST}:${PORT}…\n`);
    announced = true;
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

// Never block the UI outright: a developer who only wants the front end should
// still get it, with the reason spelled out rather than as a wall of proxy errors.
process.stderr.write(
  `[picone] API did not come up on ${HOST}:${PORT} within ${TIMEOUT_MS / 1000}s — starting Vite anyway.\n` +
    `[picone] Requests will fail until it does. Check the server output above for why.\n`,
);
process.exit(0);
