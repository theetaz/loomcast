// Loaded with the route definition (not split), so it stays free of queries and components.

/** The task lists an admin acts on: the dead-letter list and tasks that failed for good. */
export const TASK_VIEWS = ["dead", "failed"] as const;
export type TaskView = (typeof TASK_VIEWS)[number];
