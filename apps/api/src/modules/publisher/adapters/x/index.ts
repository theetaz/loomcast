import type { PublisherAdapter } from "../../types";
import { notConfiguredAdapter } from "../not-configured";

/**
 * The live X adapter. A stub until the live adapter lands: it refuses with
 * `not_configured`. The live adapter must send what `requests/x.ts` builds.
 */
export const xAdapter: PublisherAdapter = notConfiguredAdapter("x");
