import { readFileSync } from "node:fs";
import express, { type Request, type Response, type Router } from "express";
import type { CommentStatus, WorkspaceFile } from "@picone/protocol";
import type { App } from "./app.ts";
import { listRecentWorkspaces, forgetWorkspace } from "./db.ts";
import { listDirectory, searchFiles } from "./files/browser.ts";
import { gitChanges } from "./files/git.ts";
import { completePath, inspectPath } from "./files/paths.ts";
import { readFileForTab } from "./files/reader.ts";
import { expandPath, resolveWithinRoots } from "./util/paths.ts";
import { loadWorkspace, WorkspaceLoadError } from "./workspace/loader.ts";

export function createApiRouter(app: App): Router {
  const router = express.Router();

  const asyncRoute =
    (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
      handler(req, res).catch((err: Error) => {
        if (err instanceof WorkspaceLoadError) {
          res.status(400).json({ error: err.message, details: err.errors });
          return;
        }
        res.status(400).json({ error: err.message });
      });
    };

  /** Reads are confined to the workspace roots plus the workspace file itself. */
  const resolveReadable = (target: string): string => {
    const workspace = app.getWorkspace();
    const abs = expandPath(target);
    if (workspace && abs === workspace.path) return abs;
    const allowed = resolveWithinRoots(app.roots, target);
    if (!allowed) throw new Error(`Path is outside the workspace: ${target}`);
    return allowed;
  };

  // --- workspace -------------------------------------------------------------

  router.get("/state", (_req, res) => {
    res.json(app.state());
  });

  router.get("/workspaces/recent", (_req, res) => {
    res.json({ workspaces: listRecentWorkspaces() });
  });

  router.delete("/workspaces/recent", (req, res) => {
    forgetWorkspace(String(req.query.path ?? ""));
    res.json({ workspaces: listRecentWorkspaces() });
  });

  router.post(
    "/workspace/open",
    asyncRoute(async (req, res) => {
      const target = String(req.body?.path ?? "");
      if (!target) throw new Error("path is required");
      const workspace = await app.openWorkspace(target);
      res.json({ workspace, state: app.state() });
    }),
  );

  router.post(
    "/workspace/create",
    asyncRoute(async (req, res) => {
      const directory = String(req.body?.directory ?? "");
      if (!directory) throw new Error("directory is required");
      const workspace = await app.createAndOpenWorkspace({
        directory,
        name: typeof req.body?.name === "string" ? req.body.name : undefined,
        location: req.body?.location === "central" ? "central" : "inside",
      });
      res.json({ workspace, state: app.state() });
    }),
  );

  router.post(
    "/workspace/close",
    asyncRoute(async (_req, res) => {
      await app.closeWorkspace();
      res.json({ ok: true });
    }),
  );

  router.post(
    "/workspace/validate",
    asyncRoute(async (req, res) => {
      const target = String(req.body?.path ?? "");
      try {
        const workspace = loadWorkspace(target);
        res.json({ ok: true, workspace });
      } catch (err) {
        if (err instanceof WorkspaceLoadError) {
          res.json({ ok: false, error: err.message, details: err.errors });
          return;
        }
        throw err;
      }
    }),
  );

  router.put(
    "/workspace",
    asyncRoute(async (req, res) => {
      const file = req.body?.file as WorkspaceFile | undefined;
      if (!file) throw new Error("file is required");
      const workspace = await app.updateWorkspaceFile(file);
      res.json({ workspace, state: app.state() });
    }),
  );

  // --- filesystem ------------------------------------------------------------

  router.get(
    "/files/list",
    asyncRoute(async (req, res) => {
      const target = resolveReadable(String(req.query.path ?? ""));
      res.json({ path: target, entries: listDirectory(target, { showHidden: req.query.hidden === "1" }) });
    }),
  );

  router.get(
    "/files/read",
    asyncRoute(async (req, res) => {
      const target = resolveReadable(String(req.query.path ?? ""));
      res.json(readFileForTab(target));
    }),
  );

  router.get(
    "/files/search",
    asyncRoute(async (req, res) => {
      const query = String(req.query.q ?? "").trim();
      if (query.length < 2) {
        res.json({ results: [] });
        return;
      }
      const rootParam = req.query.root ? resolveReadable(String(req.query.root)) : null;
      const roots = rootParam ? [rootParam] : app.roots;
      const results = roots.flatMap((root) => searchFiles(root, query, 60));
      res.json({ results: results.slice(0, 200) });
    }),
  );

  router.get(
    "/git/changes",
    asyncRoute(async (_req, res) => {
      const perRoot = await Promise.all(
        app.roots.map(async (root) => ({ root, changes: await gitChanges(root) })),
      );
      res.json({ roots: perRoot });
    }),
  );

  /**
   * Path completion and inspection for the workspace picker. Deliberately not
   * restricted to the workspace roots — the user is choosing where a workspace
   * lives on their own machine, and the server only ever binds to localhost.
   */
  router.get(
    "/paths/complete",
    asyncRoute(async (req, res) => {
      res.json(completePath(String(req.query.q ?? "")));
    }),
  );

  router.get(
    "/paths/inspect",
    asyncRoute(async (req, res) => {
      res.json(inspectPath(String(req.query.path ?? "")));
    }),
  );

  // --- comments --------------------------------------------------------------

  router.get("/comments", (_req, res) => {
    res.json({ comments: app.comments() });
  });

  router.post(
    "/comments",
    asyncRoute(async (req, res) => {
      const { path: filePath, matcher, lineStart, lineEnd, body } = req.body ?? {};
      if (typeof filePath !== "string" || typeof matcher !== "string" || typeof body !== "string") {
        throw new Error("path, matcher and body are required");
      }
      const comment = await app.addComment({
        path: filePath,
        matcher,
        body,
        lineStart: typeof lineStart === "number" ? lineStart : undefined,
        lineEnd: typeof lineEnd === "number" ? lineEnd : undefined,
      });
      res.json({ comment });
    }),
  );

  router.post(
    "/comments/:id/status",
    asyncRoute(async (req, res) => {
      const status = String(req.body?.status ?? "") as CommentStatus;
      if (!["open", "addressed", "resolved"].includes(status)) throw new Error("invalid status");
      const comment = app.setCommentStatus(String(req.params.id), status);
      res.json({ comment });
    }),
  );

  // --- sessions --------------------------------------------------------------

  router.get("/sessions", (_req, res) => {
    res.json({ sessions: app.allSessions(), activeSessionId: app.state().activeSessionId });
  });

  router.post(
    "/sessions",
    asyncRoute(async (req, res) => {
      const session = await app.createSession(String(req.body?.title ?? "New session"));
      res.json({ session: session.summary() });
    }),
  );

  router.post(
    "/sessions/:id/select",
    asyncRoute(async (req, res) => {
      await app.selectSession(String(req.params.id));
      res.json({ ok: true });
    }),
  );

  router.patch(
    "/sessions/:id",
    asyncRoute(async (req, res) => {
      app.renameSession(String(req.params.id), String(req.body?.title ?? ""));
      res.json({ ok: true });
    }),
  );

  router.delete(
    "/sessions/:id",
    asyncRoute(async (req, res) => {
      await app.removeSession(String(req.params.id));
      res.json({ ok: true });
    }),
  );

  router.post(
    "/sessions/:id/model",
    asyncRoute(async (req, res) => {
      const { provider, model, thinking } = req.body ?? {};
      if (typeof provider !== "string" || typeof model !== "string") {
        throw new Error("provider and model are required");
      }
      await app.setSessionModel(
        String(req.params.id),
        provider,
        model,
        typeof thinking === "string" ? thinking : undefined,
      );
      res.json({ ok: true });
    }),
  );

  router.get(
    "/sessions/:id/commands",
    asyncRoute(async (req, res) => {
      res.json({ commands: app.commands(String(req.params.id)) });
    }),
  );

  // --- misc ------------------------------------------------------------------

  router.get(
    "/models",
    asyncRoute(async (_req, res) => {
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
      const runtime = await ModelRuntime.create();
      const available = await runtime.getAvailable();
      res.json({
        models: available.map((m: { provider: string; id: string; name?: string }) => ({
          provider: m.provider,
          id: m.id,
          name: m.name ?? m.id,
        })),
      });
    }),
  );

  router.get(
    "/workspace/raw",
    asyncRoute(async (_req, res) => {
      const workspace = app.getWorkspace();
      if (!workspace) throw new Error("No workspace is open");
      res.json({ path: workspace.path, content: readFileSync(workspace.path, "utf8") });
    }),
  );

  return router;
}
