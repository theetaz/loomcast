import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SkillDetail } from "@/features/skills/SkillDetail";

/** `?version=2` shows an earlier version, `?file=templates/hook.md` another file. */
const SkillSearchSchema = z.object({
  version: z.coerce.number().int().min(1).optional().catch(undefined),
  file: z.string().min(1).max(200).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/skills/$name")({
  validateSearch: SkillSearchSchema,
  staticData: { breadcrumb: (params) => params.name ?? "Skill" },
  component: SkillPage,
});

function SkillPage() {
  const { name } = Route.useParams();
  const { version, file } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SkillDetail
      key={name}
      name={name}
      version={version}
      file={file}
      onSelect={(next) => void navigate({ search: next, replace: true })}
    />
  );
}
