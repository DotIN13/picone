import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const PORT = Number(process.env.PICONE_PORT ?? 4319);
export const HOST = process.env.PICONE_HOST ?? "127.0.0.1";

/** Where Picone keeps its own runtime state (sqlite db, last workspace pointer). */
export const DATA_DIR = process.env.PICONE_DATA_DIR ?? path.join(homedir(), ".picone");

export const DB_PATH = path.join(DATA_DIR, "picone.db");

/** Max bytes we will ship to the browser for a single file tab. */
export const MAX_FILE_BYTES = 2_000_000;

/** Directory entries returned per listing before we truncate. */
export const MAX_DIR_ENTRIES = 2000;

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}
