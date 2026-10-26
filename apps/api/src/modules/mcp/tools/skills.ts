import { pipelineTools, type SkillVersionDetail } from "@loomcast/contracts";
import type { SkillsService } from "../../skills/service";
import { defineTool, McpToolError, type ToolDefinition } from "./registry";

export interface SkillToolsDeps {
  skills: SkillsService;
}

/** Most skills named one by one in the `skill.pull` summary. */
const PULL_SUMMARY_LIMIT = 20;

function pulled(detail: SkillVersionDetail) {
  return {
    name: detail.name,
    kind: detail.kind,
    version: detail.version,
    checksum: detail.checksum,
    files: detail.files,
  };
}

/**
 * `skill.pull` and `skill.publish`. Skills are global, so neither tool is tied to a workspace; job
 * tokens may pull (studio agents sync with them) but never publish.
 */
export function createSkillTools(deps: SkillToolsDeps): ToolDefinition[] {
  const { skills } = deps;

  const pull = defineTool(pipelineTools["skill.pull"], {
    async handler(input) {
      if (input.name === undefined) {
        return { skills: (await skills.pullAll()).map(pulled) };
      }
      const detail = await skills.get(input.name, input.version);
      if (detail === null) {
        throw new McpToolError(
          "not_found",
          input.version === undefined
            ? "No skill has that name."
            : "The skill has no version with that number.",
        );
      }
      return { skills: [pulled(detail)] };
    },
    summary: ({ skills: list }) => {
      if (list.length === 0) {
        return "No skills are published yet.";
      }
      const lines = list
        .slice(0, PULL_SUMMARY_LIMIT)
        .map(
          (skill) =>
            `- ${skill.name} (${skill.kind}) version ${skill.version}, ${skill.files.length} ` +
            `file${skill.files.length === 1 ? "" : "s"}, checksum ${skill.checksum}`,
        );
      if (list.length > PULL_SUMMARY_LIMIT) {
        lines.push(`- and ${list.length - PULL_SUMMARY_LIMIT} more`);
      }
      return [`${list.length} skill${list.length === 1 ? "" : "s"}:`, ...lines].join("\n");
    },
  });

  const publish = defineTool(pipelineTools["skill.publish"], {
    async handler(input, { caller }) {
      const { version, created } = await skills.publish(
        {
          name: input.name,
          kind: input.kind,
          files: input.files,
          ...(input.changelog === undefined ? {} : { changelog: input.changelog }),
        },
        { kind: "token", id: caller.token.id, userId: caller.token.user.id, ip: caller.ip },
      );
      return { name: version.name, version: version.version, checksum: version.checksum, created };
    },
    summary: ({ name, version, checksum, created }) =>
      created
        ? `Published ${name} version ${version} (checksum ${checksum}).`
        : `${name} already has these files as version ${version} (checksum ${checksum}); ` +
          "no new version was made.",
  });

  return [pull, publish];
}
