import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

interface LockDatabase {
  exec(sql: string): unknown;
  close(): void;
}

/** A native transport stopped; the saved scan can continue in another host. */
export class ScanTransportClosedError extends Error {}

/** A required worker permission cannot be preserved by the selected runtime. */
export class ScanPermissionError extends Error {}

/** A process-owned transaction protects ordinary saved scans across SDK and native hosts. */
export async function acquireScanExecution(
  stateDirectory: string,
  scanDirectory: string,
): Promise<() => void> {
  const directory = join(stateDirectory, "scan-execution");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Scan execution locks require a real directory.");
  const key = createHash("sha256")
    .update(await realpath(scanDirectory))
    .digest("hex");
  const path = join(directory, key + ".sqlite");
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata !== null && (!metadata.isFile() || metadata.nlink !== 1))
    throw new Error("Scan execution lock must be an ordinary file.");
  const require = createRequire(import.meta.url);
  const Database: new (path: string) => LockDatabase = process.versions["bun"]
    ? require("bun:sqlite").Database
    : require("node:sqlite").DatabaseSync;
  const database = new Database(path);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    const sqlite = error as { errcode?: number; code?: string };
    if (sqlite.errcode === 5 || sqlite.code === "SQLITE_BUSY")
      throw new Error("This saved scan is already running in another client.", {
        cause: error,
      });
    throw error;
  }
  return () => database.close();
}
