import type { PublisherAdapter } from "../../types";
import { notConfiguredAdapter } from "../not-configured";

/**
 * The live Facebook Page Reels adapter. A stub until the live adapter lands: it refuses with
 * `not_configured`. The live adapter must send what `requests/facebook.ts` builds.
 */
export const facebookAdapter: PublisherAdapter = notConfiguredAdapter("facebook");
