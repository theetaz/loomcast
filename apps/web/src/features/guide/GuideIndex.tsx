import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Page, PageHeader } from "@/components/PageHeader";
import { GUIDE_GROUPS, guidePages } from "./pages";

/** Every guide page, by group. */
export function GuideIndex() {
  return (
    <Page className="max-w-[880px]">
      <PageHeader
        title="Guide"
        description="How to use Loomcast, keep the studio agent running, and fix things when they break."
      />
      {GUIDE_GROUPS.map((group) => {
        const pages = guidePages.filter((page) => page.group === group);
        if (pages.length === 0) return null;
        return (
          <section key={group} aria-labelledby={`guide-${group}`} className="flex flex-col gap-2">
            <h2 id={`guide-${group}`} className="text-heading text-foreground">
              {group}
            </h2>
            <ul className="overflow-hidden rounded-lg bg-card shadow-card">
              {pages.map((page) => (
                <li key={page.slug} className="border-divider border-b last:border-b-0">
                  <Link
                    to="/guide/$slug"
                    params={{ slug: page.slug }}
                    className="flex items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="font-medium text-foreground">{page.title}</span>
                      <span className="text-control text-muted-foreground">{page.summary}</span>
                    </span>
                    <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </Page>
  );
}
