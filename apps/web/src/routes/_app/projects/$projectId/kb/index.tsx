import { KbTagSchema } from "@loomcast/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { KnowledgePage } from "@/features/kb/KnowledgePage";
import { KB_FILTERS } from "@/features/kb/kinds";
import { ProjectTabBody } from "@/features/project/ProjectLayout";

const kbSearchSchema = z.object({
  kind: z.enum(KB_FILTERS).optional().catch(undefined),
  tag: KbTagSchema.optional().catch(undefined),
  q: z.string().max(200).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/projects/$projectId/kb/")({
  validateSearch: kbSearchSchema,
  component: KnowledgeTab,
});

function KnowledgeTab() {
  const { projectId } = Route.useParams();
  const { kind = "all", tag, q = "" } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ProjectTabBody idOrSlug={projectId} title="Knowledge">
      {(project) => (
        <KnowledgePage
          project={project}
          projectParam={projectId}
          state={{ kind, tag: tag ?? null, q }}
          onStateChange={(next) =>
            void navigate({
              search: {
                ...(next.kind === "all" ? {} : { kind: next.kind }),
                ...(next.tag ? { tag: next.tag } : {}),
                ...(next.q ? { q: next.q } : {}),
              },
              replace: true,
            })
          }
        />
      )}
    </ProjectTabBody>
  );
}
