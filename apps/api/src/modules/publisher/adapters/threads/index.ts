import type { PublisherAdapter } from "../../types";
import { UNCONFIGURED_META_PLATFORMS } from "../facebook/meta-call";
import { createThreadsAdapter } from "./adapter";

export { createThreadsAdapter } from "./adapter";
export {
  type ThreadsContainer,
  ThreadsContainerSchema,
  threadsContainerState,
} from "./status";

/**
 * The Threads adapter of the registry, on the default Threads API host and without the reauth
 * path. The publisher module builds the configured one with `createThreadsAdapter` from the
 * server's platform settings and the channels module's reauth path.
 */
export const threadsAdapter: PublisherAdapter = createThreadsAdapter({
  platforms: UNCONFIGURED_META_PLATFORMS,
});
