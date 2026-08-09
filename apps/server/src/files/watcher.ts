import { statSync } from "node:fs";
import chokidar, { type FSWatcher } from "chokidar";

/**
 * Watches only the files that are currently open in a tab (DESIGN §8/§24).
 * Watching whole repositories would be far more expensive than it is worth for
 * the one thing we need: "the file in front of the user changed on disk".
 */
export class OpenFileWatcher {
  private watcher: FSWatcher | null = null;
  private readonly refCounts = new Map<string, number>();

  constructor(private readonly onChange: (path: string, mtime: number) => void) {}

  watch(absPath: string): void {
    const count = this.refCounts.get(absPath) ?? 0;
    this.refCounts.set(absPath, count + 1);
    if (count > 0) return;

    this.ensureWatcher().add(absPath);
  }

  unwatch(absPath: string): void {
    const count = this.refCounts.get(absPath) ?? 0;
    if (count <= 1) {
      this.refCounts.delete(absPath);
      this.watcher?.unwatch(absPath);
      return;
    }
    this.refCounts.set(absPath, count - 1);
  }

  /** Drop every watch — used when the workspace is closed or swapped. */
  async reset(): Promise<void> {
    this.refCounts.clear();
    const watcher = this.watcher;
    this.watcher = null;
    await watcher?.close();
  }

  private ensureWatcher(): FSWatcher {
    if (this.watcher) return this.watcher;
    this.watcher = chokidar.watch([], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    });
    this.watcher.on("change", (p) => this.emit(p));
    this.watcher.on("add", (p) => this.emit(p));
    this.watcher.on("unlink", (p) => this.onChange(p, 0));
    this.watcher.on("error", () => {});
    return this.watcher;
  }

  private emit(p: string): void {
    let mtime = 0;
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      /* file vanished between event and stat */
    }
    this.onChange(p, mtime);
  }
}
