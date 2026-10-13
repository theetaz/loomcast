import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentPaths } from "../paths";
import { ensurePrivateDir, isNotFound, writePrivateFileAtomic } from "../private-fs";

/** At most this many conversations are remembered; the oldest entries are dropped first. */
const MAX_ENTRIES = 1_000;

const SessionFileSchema = z.record(z.string(), z.string().min(1).max(200));

/**
 * A local `{conversationId → sessionId}` cache. The server normally sends the conversation's
 * `producerSessionId` with each job; the cache is used only when it does not, for example when an
 * earlier job's result was lost.
 */
export class ProducerSessions {
  readonly #home: string;
  readonly #file: string;

  constructor(paths: Pick<AgentPaths, "home">) {
    this.#home = paths.home;
    this.#file = join(paths.home, "producer-sessions.json");
  }

  get(conversationId: string): string | undefined {
    return this.#read().get(conversationId);
  }

  set(conversationId: string, sessionId: string): void {
    const entries = this.#read();
    entries.delete(conversationId);
    entries.set(conversationId, sessionId);
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      entries.delete(oldest);
    }
    ensurePrivateDir(this.#home);
    writePrivateFileAtomic(this.#file, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
  }

  /** Entries in insertion order, oldest first. A missing or unreadable file is an empty cache. */
  #read(): Map<string, string> {
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return new Map();
      }
      throw error;
    }
    try {
      return new Map(Object.entries(SessionFileSchema.parse(JSON.parse(text))));
    } catch {
      return new Map();
    }
  }
}
