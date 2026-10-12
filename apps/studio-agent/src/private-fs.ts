import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

// The agent's state holds the device token and job output, so every directory it creates is
// private to the user (0700) and every file is readable only by the user (0600).

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Creates `dir` (and missing parents) and makes sure it is private, even if it already existed. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(dir, PRIVATE_DIR_MODE);
}

/**
 * Replaces `path` with `content` atomically: the data goes to a private temporary file in the same
 * directory, is flushed to disk and is then renamed over the target. A crash leaves either the old
 * or the new file, never a torn one.
 */
export function writePrivateFileAtomic(path: string, content: string): void {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const fd = openSync(temporary, "w", PRIVATE_FILE_MODE);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  chmodSync(temporary, PRIVATE_FILE_MODE);
  renameSync(temporary, path);
}

/** Appends `content` to a private file and flushes it to disk before returning. */
export function appendPrivateFileSync(path: string, content: string): void {
  const fd = openSync(path, "a", PRIVATE_FILE_MODE);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Whether a Node error is "no such file or directory". */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
