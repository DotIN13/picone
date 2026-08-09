import type {
  CommentStatus,
  CreateWorkspaceRequest,
  DirEntry,
  FileComment,
  FileContent,
  GitStatus,
  GlobalSettings,
  ModelOption,
  PathCompleteResponse,
  PathInspectResponse,
  RecentWorkspace,
  SessionSummary,
  SlashCommand,
  Workspace,
  WorkspaceFile,
  WorkspaceStateResponse,
} from "@picone/protocol";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const err = body as { error?: string; details?: string[] };
    const detail = err.details?.length ? `\n${err.details.join("\n")}` : "";
    throw new Error(`${err.error ?? response.statusText}${detail}`);
  }
  return body as T;
}

export const api = {
  state: () => request<WorkspaceStateResponse>("/state"),

  recentWorkspaces: () => request<{ workspaces: RecentWorkspace[] }>("/workspaces/recent"),
  forgetWorkspace: (path: string) =>
    request<{ workspaces: RecentWorkspace[] }>(`/workspaces/recent?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),

  openWorkspace: (path: string) =>
    request<{ workspace: Workspace; state: WorkspaceStateResponse }>("/workspace/open", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  closeWorkspace: () => request<{ ok: true }>("/workspace/close", { method: "POST" }),
  saveWorkspace: (file: WorkspaceFile) =>
    request<{ workspace: Workspace; state: WorkspaceStateResponse }>("/workspace", {
      method: "PUT",
      body: JSON.stringify({ file }),
    }),
  workspaceRaw: () => request<{ path: string; content: string }>("/workspace/raw"),

  listDirectory: (path: string) =>
    request<{ path: string; entries: DirEntry[] }>(`/files/list?path=${encodeURIComponent(path)}`),
  readFile: (path: string) => request<FileContent>(`/files/read?path=${encodeURIComponent(path)}`),
  searchFiles: (q: string) => request<{ results: DirEntry[] }>(`/files/search?q=${encodeURIComponent(q)}`),
  gitChanges: () =>
    request<{ roots: Array<{ root: string; changes: Array<{ path: string; status: GitStatus }> }> }>("/git/changes"),

  completePath: (query: string) => request<PathCompleteResponse>(`/paths/complete?q=${encodeURIComponent(query)}`),
  inspectPath: (path: string) => request<PathInspectResponse>(`/paths/inspect?path=${encodeURIComponent(path)}`),
  createWorkspace: (body: CreateWorkspaceRequest) =>
    request<{ workspace: Workspace; state: WorkspaceStateResponse }>("/workspace/create", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  comments: () => request<{ comments: FileComment[] }>("/comments"),
  setCommentStatus: (id: string, status: CommentStatus) =>
    request<{ comment: FileComment }>(`/comments/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }),

  sessions: () => request<{ sessions: SessionSummary[]; activeSessionId: string | null }>("/sessions"),
  createSession: (title: string) =>
    request<{ session: SessionSummary }>("/sessions", { method: "POST", body: JSON.stringify({ title }) }),
  selectSession: (id: string) => request<{ ok: true }>(`/sessions/${id}/select`, { method: "POST" }),
  renameSession: (id: string, title: string) =>
    request<{ ok: true }>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteSession: (id: string) => request<{ ok: true }>(`/sessions/${id}`, { method: "DELETE" }),

  setSessionModel: (id: string, provider: string, model: string, thinking?: string) =>
    request<{ ok: true }>(`/sessions/${id}/model`, {
      method: "POST",
      body: JSON.stringify({ provider, model, thinking }),
    }),
  sessionCommands: (id: string) => request<{ commands: SlashCommand[] }>(`/sessions/${id}/commands`),

  models: () => request<{ models: ModelOption[] }>("/models"),

  settings: () => request<{ settings: GlobalSettings; errors: string[] }>("/settings"),
  saveSettings: (settings: GlobalSettings) =>
    request<{ settings: GlobalSettings; errors: string[] }>("/settings", {
      method: "PUT",
      body: JSON.stringify({ settings }),
    }),
};
