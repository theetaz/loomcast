import { Separator } from "@loomcast/ui/components/separator";
import { SidebarTrigger } from "@loomcast/ui/components/sidebar";
import { StudioStatus } from "@/features/devices/StudioStatus";
import { Breadcrumbs } from "./Breadcrumbs";
import { SearchButton } from "./SearchButton";

/** The 44px bar above every page: sidebar toggle, breadcrumbs, search and studio status. */
export function Topbar() {
  return (
    <header className="sticky top-0 z-20 flex h-11 shrink-0 items-center gap-2 border-border border-b bg-background px-2.5 md:px-3.5">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mr-1 h-4 self-center! bg-border" />
      <Breadcrumbs />
      <div className="flex shrink-0 items-center gap-2">
        <SearchButton />
        <StudioStatus />
      </div>
    </header>
  );
}
