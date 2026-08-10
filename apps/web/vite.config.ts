import { createLogger, defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const SERVER = process.env.PICONE_SERVER ?? "http://127.0.0.1:4319";

/**
 * A websocket losing its far end is not an error worth a stack trace.
 *
 * Closing a tab, reloading, or `tsx watch` restarting the API all cut a proxied
 * socket mid-flight, and the client then retries on a backoff until the server
 * is back — every attempt against a dead port logging fifteen more lines. At a
 * glance it is indistinguishable from a real failure, which is worse than
 * useless: it teaches you to ignore the log.
 *
 * Filtered on the **websocket path only**. That is the line that matters: the
 * socket reconnects by design and the status pill already says `Offline` while
 * it does, so the log adds nothing. An `/api` request failing is not retried in
 * a loop and is a real symptom, so http proxy errors still come through — as
 * does any websocket error that is not one end hanging up.
 */
const HANGUP = /\b(ECONNABORTED|ECONNRESET|ECONNREFUSED|EPIPE)\b/;
const WS_PROXY_NOISE = /ws proxy (socket )?error/;

const logger = createLogger();
const inherited = logger.error;
logger.error = (msg, options) => {
  if (WS_PROXY_NOISE.test(msg) && HANGUP.test(msg)) return;
  inherited(msg, options);
};

export default defineConfig({
  customLogger: logger,
  plugins: [solid(), tailwindcss()],
  // Two copies of solid-js would each own their own reactive graph.
  resolve: { dedupe: ["solid-js"] },
  server: {
    port: 4318,
    strictPort: true,
    proxy: {
      "/api": { target: SERVER, changeOrigin: true },
      "/ws": { target: SERVER, ws: true },
    },
  },
  build: {
    target: "esnext",
    outDir: "dist",
    sourcemap: true,
  },
});
