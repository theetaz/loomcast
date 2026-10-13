import { type Project, projectTools } from "@loomcast/contracts";
import type { ProjectActor, ProjectsService } from "../../projects/service";
import type { McpCaller } from "../caller";
import { defineTool, McpToolError, type ToolDefinition } from "./registry";

export interface ProjectToolsDeps {
  projects: ProjectsService;
  /** Origin of the web app, for links to projects. */
  appOrigin: string;
}

/** Most projects named one by one in the `project.list` summary. */
const LIST_SUMMARY_LIMIT = 20;

const notFound = () => new McpToolError("not_found", "No project has that id or slug.");

/** Link to a project in the web app. */
export function projectUrl(appOrigin: string, project: Pick<Project, "slug">): string {
  return new URL(`/projects/${encodeURIComponent(project.slug)}`, appOrigin).toString();
}

/** A token acts for its user; the audit row of the change names the token. */
function actor(caller: McpCaller): ProjectActor {
  return { kind: "token", id: caller.token.id, userId: caller.token.user.id, ip: caller.ip };
}

function describe(project: Pick<Project, "name" | "slug" | "id">): string {
  return `"${project.name}" (slug ${project.slug}, id ${project.id})`;
}

/** `project.create`, `project.get` and `project.list`, backed by the projects service. */
export function createProjectTools(deps: ProjectToolsDeps): ToolDefinition[] {
  const { projects, appOrigin } = deps;

  const create = defineTool(projectTools["project.create"], {
    async handler(input, { caller }) {
      // The service publishes `project.created` once committed, so the web app updates live.
      const project = await projects.create(input, actor(caller));
      return {
        project: {
          id: project.id,
          slug: project.slug,
          name: project.name,
          description: project.description,
          url: projectUrl(appOrigin, project),
        },
      };
    },
    summary: ({ project }) => `Created project ${describe(project)}: ${project.url}`,
  });

  const get = defineTool(projectTools["project.get"], {
    async resolveProject(input) {
      const project = await projects.get(input.idOrSlug);
      return project?.id ?? null;
    },
    async handler(_input, { projectId }) {
      const project = projectId === null ? null : await projects.get(projectId);
      if (project === null) {
        throw notFound();
      }
      return { project, stats: await projects.stats(project.id) };
    },
    summary: ({ project, stats }) =>
      `Project ${describe(project)} is ${project.status}, with ${stats.conversations} conversations, ` +
      `${stats.kbEntries} knowledge-base entries and ${stats.items} content items.`,
  });

  const list = defineTool(projectTools["project.list"], {
    async handler(input, { caller }) {
      const all = await projects.list(input);
      // A bound caller (a job token) only sees its own project.
      const visible =
        caller.boundProjectId === null
          ? all
          : all.filter((project) => project.id === caller.boundProjectId);
      return { projects: visible };
    },
    summary: ({ projects: found }) => {
      if (found.length === 0) {
        return "No projects found.";
      }
      const lines = found
        .slice(0, LIST_SUMMARY_LIMIT)
        .map((project) => `- ${describe(project)}, ${project.status}`);
      if (found.length > LIST_SUMMARY_LIMIT) {
        lines.push(`- and ${found.length - LIST_SUMMARY_LIMIT} more`);
      }
      return [`${found.length} project${found.length === 1 ? "" : "s"}:`, ...lines].join("\n");
    },
  });

  return [create, get, list];
}
