import type { ModuleDeps } from "../../deps";
import { createResearchService, type ResearchService } from "./service";

export {
  type Leaderboard,
  type LeaderboardVideo,
  median,
  type OwnTopicPost,
  outlierScore,
  topicLeaderboard,
} from "./math";
export {
  type AddVideosResult,
  createResearchService,
  type ResearchService,
  type ResearchServiceDeps,
  type SyncResult,
} from "./service";
export {
  type AccountWrite,
  discoveredVideos,
  recomputeAccounts,
  storeInstagramDiscovery,
  upsertAccount,
  upsertVideos,
  type VideoWrite,
} from "./store";

/**
 * The research service of the app, built from its module deps. Research has no REST routes yet:
 * the MCP tools read and write it, and competitor scans feed it.
 */
export function researchServiceFor(deps: ModuleDeps): ResearchService {
  return createResearchService({
    db: deps.db,
    clock: deps.clock,
    vault: deps.vault,
    platforms: deps.config.platforms,
    logger: deps.logger.child({ module: "research" }),
  });
}
