import { createFileRoute } from "@tanstack/react-router";
import { MembersSettings } from "@/features/members/MembersSettings";
import { useTitle } from "@/lib/use-title";

export const Route = createFileRoute("/_app/settings/members")({
  staticData: { breadcrumb: "Members" },
  component: MembersPage,
});

function MembersPage() {
  useTitle("Members");
  return <MembersSettings />;
}
