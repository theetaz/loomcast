import { createFileRoute } from "@tanstack/react-router";
import { GuidePageView } from "@/features/guide/GuidePageView";
import { guidePage } from "@/features/guide/pages";

export const Route = createFileRoute("/_app/guide/$slug")({
  staticData: { breadcrumb: (params) => guidePage(params.slug ?? "")?.title ?? "Page" },
  component: GuideSlugPage,
});

function GuideSlugPage() {
  const { slug } = Route.useParams();
  return <GuidePageView slug={slug} />;
}
