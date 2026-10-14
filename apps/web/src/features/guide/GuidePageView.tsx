import { Button } from "@loomcast/ui/components/button";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon, BookOpenIcon } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/EmptyState";
import { Page, PageHeader } from "@/components/PageHeader";
import { useTitle } from "@/lib/use-title";
import { GuideMarkdown } from "./GuideMarkdown";
import { guideBody, guidePage, guidePages, headingId } from "./pages";

/** The page's `## ` headings, for the "On this page" list. Fenced code is skipped. */
function sectionsOf(markdown: string): { id: string; title: string }[] {
  const sections: { id: string; title: string }[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    const match = !inFence && /^##\s+(.+)$/.exec(line);
    if (match && match[1] !== undefined) {
      const title = match[1].replace(/`/g, "").trim();
      sections.push({ id: headingId(title), title });
    }
  }
  return sections;
}

export function GuidePageView({ slug }: { slug: string }) {
  const page = guidePage(slug);
  useTitle(page ? `${page.title} · Guide` : "Guide");
  const body = useMemo(() => (page ? guideBody(page.markdown) : ""), [page]);
  const sections = useMemo(() => sectionsOf(body), [body]);

  if (!page) {
    return (
      <Page>
        <EmptyState
          icon={BookOpenIcon}
          title="No such guide page"
          description="The page may have been renamed. The guide's index lists every page."
          action={
            <Button asChild variant="outline">
              <Link to="/guide">All guide pages</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  const index = guidePages.indexOf(page);
  const previous = guidePages[index - 1];
  const next = guidePages[index + 1];

  return (
    <Page className="max-w-[1180px]">
      <PageHeader title={page.title} description={page.summary} />
      <div className="flex items-start gap-10">
        <article className="min-w-0 max-w-[820px] flex-1">
          <GuideMarkdown markdown={body} />
          <nav
            aria-label="More guide pages"
            className="mt-10 flex flex-wrap justify-between gap-3 border-divider border-t pt-5"
          >
            {previous ? (
              <Button asChild variant="ghost">
                <Link to="/guide/$slug" params={{ slug: previous.slug }}>
                  <ArrowLeftIcon aria-hidden="true" />
                  {previous.title}
                </Link>
              </Button>
            ) : (
              <span />
            )}
            {next ? (
              <Button asChild variant="ghost">
                <Link to="/guide/$slug" params={{ slug: next.slug }}>
                  {next.title}
                  <ArrowRightIcon aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
          </nav>
        </article>
        {sections.length > 1 ? (
          <nav
            aria-label="On this page"
            className="sticky top-16 hidden w-52 shrink-0 flex-col gap-1.5 xl:flex"
          >
            <p className="font-medium text-control text-foreground">On this page</p>
            {sections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className="rounded-sm text-control text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {section.title}
              </a>
            ))}
          </nav>
        ) : null}
      </div>
    </Page>
  );
}
