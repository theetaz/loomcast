import { LoomcastMark } from "@loomcast/ui/brand";
import { Button } from "@loomcast/ui/components/button";
import { cn } from "@loomcast/ui/lib/cn";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTitle } from "@/lib/use-title";
import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_EFFECTIVE_DATE,
  LEGAL_OPERATOR,
  LEGAL_SITE_URL,
} from "./contact";

const LEGAL_PAGES = [
  { to: "/privacy", label: "Privacy policy" },
  { to: "/terms", label: "Terms of service" },
  { to: "/data-deletion", label: "Data deletion" },
] as const;

const EFFECTIVE_DATE_LABEL = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
}).format(new Date(`${LEGAL_EFFECTIVE_DATE}T00:00:00Z`));

interface LegalLayoutProps {
  title: string;
  /** One or two sentences under the title. */
  summary: ReactNode;
  children: ReactNode;
}

/**
 * The public frame for the privacy policy, the terms and the data deletion
 * page: the mark, links between the three pages and a way to sign in. Public,
 * outside the signed-in app, and free of API calls.
 */
export function LegalLayout({ title, summary, children }: LegalLayoutProps) {
  useTitle(title);
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="border-divider border-b">
        <div className="mx-auto flex h-14 w-full max-w-[760px] items-center gap-3 px-5">
          <Link
            to="/login"
            className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LoomcastMark size={24} aria-hidden="true" />
            <span className="text-heading">Loomcast</span>
          </Link>
          <Button asChild variant="outline" size="sm" className="ml-auto">
            <Link to="/login">Sign in</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-8 px-5 pt-8 pb-16 sm:pt-10">
        <nav aria-label="Legal pages" className="-mx-2 flex flex-wrap gap-1">
          {LEGAL_PAGES.map((page) => (
            <Link
              key={page.to}
              to={page.to}
              className={cn(
                "rounded-md px-2 py-1 text-control text-text-2 outline-none transition-colors",
                "hover:bg-foreground/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                "data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-accent-foreground",
              )}
            >
              {page.label}
            </Link>
          ))}
        </nav>

        <article className="flex flex-col gap-8">
          <header className="flex flex-col gap-2">
            <h1 className="text-display text-balance">{title}</h1>
            <p className="text-small text-muted-foreground">
              Effective <time dateTime={LEGAL_EFFECTIVE_DATE}>{EFFECTIVE_DATE_LABEL}</time>
            </p>
            <p className="max-w-[64ch] text-[14px] text-text-2 leading-[1.65] text-pretty">
              {summary}
            </p>
          </header>
          <div className="flex flex-col gap-8">{children}</div>
        </article>
      </main>

      <footer className="border-divider border-t">
        <div className="mx-auto flex w-full max-w-[760px] flex-wrap items-center gap-x-4 gap-y-1 px-5 py-5 text-small text-muted-foreground">
          <span>
            Loomcast is operated by {LEGAL_OPERATOR} at{" "}
            <a className="underline-offset-4 hover:underline" href={LEGAL_SITE_URL}>
              {new URL(LEGAL_SITE_URL).host}
            </a>
            .
          </span>
          <ContactLink className="sm:ml-auto" />
        </div>
      </footer>
    </div>
  );
}

/** A section of a legal page, with a heading that can be linked to. */
export function LegalSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn(
        "flex max-w-[64ch] scroll-mt-6 flex-col gap-3 text-[14px] text-text-2 leading-[1.65]",
        "[&_strong]:font-medium [&_strong]:text-foreground",
        "[&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-1.5 [&_ul]:pl-5 [&_li]:pl-0.5 [&_li]:marker:text-text-4",
        "[&_ol]:flex [&_ol]:list-decimal [&_ol]:flex-col [&_ol]:gap-1.5 [&_ol]:pl-5",
      )}
    >
      <h2 id={headingId} className="text-foreground text-heading">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The contact address as a mail link. Every legal page uses this one address. */
export function ContactLink({ className }: { className?: string }) {
  return (
    <a
      href={`mailto:${LEGAL_CONTACT_EMAIL}`}
      className={cn(
        "font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline",
        className,
      )}
    >
      {LEGAL_CONTACT_EMAIL}
    </a>
  );
}
