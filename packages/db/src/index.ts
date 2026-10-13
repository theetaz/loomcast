export {
  type CreateDbOptions,
  createDb,
  type Database,
  type DbHandle,
  type Schema,
} from "./client";
export { KB_FIXTURES, type KbFixture } from "./fixtures/kb";
export { MIGRATIONS_FOLDER, migrate } from "./migrate";
export {
  escapeLikePattern,
  KB_SNIPPET_FALLBACK_LENGTH,
  type KbSearchExecutor,
  type KbSearchOptions,
  kbSearch,
  referenceSearchExtra,
} from "./queries/kb-search";
export {
  type ClaimDueTasksOptions,
  type ClaimDueTasksResult,
  claimDueTasks,
  completeTask,
  type EnqueueTaskInput,
  type EnqueueTaskResult,
  enqueueTask,
  extendLease,
  retryTask,
  TASK_ATTEMPTS_EXHAUSTED_CODE,
  TASK_LEASE_EXPIRED_CODE,
  type TaskExecutor,
  type TaskLease,
  type TaskOutcome,
  taskLease,
} from "./queries/scheduler";
export {
  nextFormatVersionNo,
  nextSkillVersion,
  nextVersionNo,
  type VersionExecutor,
} from "./queries/versions";
export * from "./schema";
export { SEED_DEDUPE_PREFIX, type SeedResult, seedKb } from "./seed-dev";
