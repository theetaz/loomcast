import type { PublisherAdapter } from "../../types";
import { notConfiguredAdapter } from "../not-configured";

/**
 * The live Instagram Reels adapter. A stub until the live adapter lands: it refuses with
 * `not_configured`. The live adapter must send what `requests/instagram.ts` builds.
 */
export const instagramAdapter: PublisherAdapter = notConfiguredAdapter("instagram");
