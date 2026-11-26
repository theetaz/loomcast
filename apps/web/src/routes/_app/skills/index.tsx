import { createFileRoute } from "@tanstack/react-router";
import { SkillsCatalogue } from "@/features/skills/SkillsCatalogue";
import { useTitle } from "@/lib/use-title";

export const Route = createFileRoute("/_app/skills/")({
  component: SkillsIndexPage,
});

function SkillsIndexPage() {
  useTitle("Skills");
  return <SkillsCatalogue />;
}
