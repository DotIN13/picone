/**
 * A path as written in a workspace file, made absolute (DESIGN §3).
 *
 * A workspace file may store paths relative to itself — `"."` is the common
 * case, and the reason the file travels with a checkout. That is the right
 * thing to *store*, and the wrong thing to hand a folder browser: `"."` would
 * resolve against wherever the server happens to have been started.
 *
 * Resolved from the value itself rather than by looking up the matching entry
 * in the loaded workspace, because the two drift the moment a row is added or
 * removed in the settings panel and the draft is no longer what is loaded.
 */

/** Windows drive letters, POSIX roots, UNC shares, and `~`. */
const ABSOLUTE = /^([a-zA-Z]:[\\/]|[\\/]|~)/;

export function resolveWorkspacePath(value: string, workspaceFile: string | undefined): string {
  const path = value.trim();
  if (path === "" || !workspaceFile) return path;
  if (ABSOLUTE.test(path)) return path;

  // The workspace file's own separator, so the result looks like the paths
  // beside it rather than a mix of the two.
  const separator = workspaceFile.includes("\\") ? "\\" : "/";
  const cut = Math.max(workspaceFile.lastIndexOf("\\"), workspaceFile.lastIndexOf("/"));
  if (cut < 0) return path;
  const directory = workspaceFile.slice(0, cut);

  const relative = path.replace(/^\.[\\/]/, "");
  if (relative === "" || relative === ".") return directory;
  return `${directory}${separator}${relative}`;
}
