import { Link, useMatches } from "@tanstack/react-router";
import { Fragment } from "react";
import "./breadcrumb-types";

/**
 * Builds the trail from the `breadcrumb` static data of the matched routes.
 * Parents link back; the current page is plain text. Phones show only the
 * current page.
 */
export function Breadcrumbs() {
  const matches = useMatches();
  const crumbs = matches.flatMap((match) => {
    const crumb = match.staticData.breadcrumb;
    if (!crumb) return [];
    const params = match.params as Record<string, string>;
    return [
      {
        id: match.id,
        pathname: match.pathname,
        label: typeof crumb === "string" ? crumb : crumb(params),
      },
    ];
  });

  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-1.5 text-control text-muted-foreground">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          if (isLast) {
            return (
              <li
                key={crumb.id}
                aria-current="page"
                className="min-w-0 truncate font-medium text-foreground"
              >
                {crumb.label}
              </li>
            );
          }
          return (
            <Fragment key={crumb.id}>
              <li className="hidden shrink-0 sm:block">
                <Link
                  to={crumb.pathname}
                  className="rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {crumb.label}
                </Link>
              </li>
              <li aria-hidden="true" className="hidden text-text-4 sm:block">
                /
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
