import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import express from "express";
import { App } from "./app.ts";
import { HOST, PORT, ensureDataDir } from "./config.ts";
import { openDb } from "./db.ts";
import { createApiRouter } from "./http.ts";
import { attachWebSocket } from "./ws.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../web/dist");

async function main(): Promise<void> {
  ensureDataDir();
  openDb();

  const app = new App();
  const server = express();

  server.use(express.json({ limit: "8mb" }));
  server.use("/api", createApiRouter(app));

  // In production the built SPA is served from the same origin; in development
  // Vite serves the UI and proxies /api and /ws here.
  if (existsSync(webDist)) {
    server.use(express.static(webDist));
    server.get(/^(?!\/api|\/ws).*/, (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  const http = createServer(server);
  attachWebSocket(http, app);

  http.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[picone] port ${PORT} is already in use — stop the other instance, or set PICONE_PORT to a free port.`,
      );
      process.exit(1);
    }
    console.error("[picone] server error:", err);
    process.exit(1);
  });

  http.listen(PORT, HOST, () => {
    console.log(`[picone] server listening on http://${HOST}:${PORT}`);
    if (!existsSync(webDist)) console.log(`[picone] web UI not built — run the dev server or 'npm run build'`);
  });

  // Restore *after* listening. Reopening a workspace builds a Pi session —
  // model runtime, extensions, MCP servers — which can take seconds or stall on
  // an unreachable server. Blocking the port on that made the whole app look
  // dead, so the UI now connects immediately and watches the restore happen.
  void app
    .restoreLastWorkspace()
    .then(() => {
      const workspace = app.getWorkspace();
      if (workspace) console.log(`[picone] workspace "${workspace.file.name}" (${workspace.path})`);
    })
    .catch((err: Error) => {
      console.warn(`[picone] could not restore last workspace: ${err.message}`);
    });

  const shutdown = async (): Promise<void> => {
    await app.closeWorkspace().catch(() => {});
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: Error) => {
  console.error("[picone] fatal:", err);
  process.exit(1);
});
