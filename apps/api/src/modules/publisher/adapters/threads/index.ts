import type { PublisherAdapter } from "../../types";
import { notConfiguredAdapter } from "../not-configured";

/**
 * The live Threads adapter. A stub until the live adapter lands: it refuses with
 * `not_configured`. The live adapter must send what `requests/threads.ts` builds.
 */
export const threadsAdapter: PublisherAdapter = notConfiguredAdapter("threads");
