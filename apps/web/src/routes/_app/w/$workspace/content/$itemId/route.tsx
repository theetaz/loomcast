import { IdSchema } from "@loomcast/contracts";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ItemPage } from "@/features/content-item/ItemPage";
import { ItemSearchSchema } from "@/features/content-item/search";
import { ContentCrumb } from "@/features/library/ContentCrumb";

export const Route = createFileRoute("/_app/w/$workspace/content/$itemId")({
  beforeLoad: ({ params }) => {
    if (!IdSchema.safeParse(params.itemId).success) throw notFound();
  },
  validateSearch: ItemSearchSchema,
  staticData: { breadcrumb: (params) => <ContentCrumb itemId={params.itemId ?? ""} /> },
  component: ContentItemRoute,
});

function ContentItemRoute() {
  const { itemId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ItemPage
      key={itemId}
      itemId={itemId}
      search={search}
      onSearchChange={(update) => void navigate({ search: update, replace: true })}
    />
  );
}
