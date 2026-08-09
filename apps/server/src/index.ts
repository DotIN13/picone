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

  await app.restoreLastWorkspace().catch((err: Error) => {
    console.warn(`[picone] could not restore last workspace: ${err.message}`);
  });

  http.listen(PORT, HOST, () => {
    console.log(`[picone] server listening on http://${HOST}:${PORT}`);
    const workspace = app.getWorkspace();
    if (workspace) console.log(`[picone] workspace "${workspace.file.name}" (${workspace.path})`);
    if (!existsSync(webDist)) console.log(`[picone] web UI not built — run the dev server or 'npm run build'`);
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
