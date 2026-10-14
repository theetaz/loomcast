import { createFileRoute } from "@tanstack/react-router";
import { GuideIndex } from "@/features/guide/GuideIndex";
import { useTitle } from "@/lib/use-title";

export const Route = createFileRoute("/_app/guide/")({
  component: GuideIndexPage,
});

function GuideIndexPage() {
  useTitle("Guide");
  return <GuideIndex />;
}
