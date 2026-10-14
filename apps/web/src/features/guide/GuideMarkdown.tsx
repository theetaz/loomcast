import { Link } from "@tanstack/react-router";
import { Children, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { markdownComponents, markdownPlugins } from "@/features/conversation/Markdown";
import { guideImageUrl, guideLinkTarget, headingId } from "./pages";

/** Repository files the guide links to (`../runbooks/deploy.md`) open on GitHub. */
const REPOSITORY_DOCS = "https://github.com/theetaz/loomcast/blob/main/docs/";

const linkClass =
  "rounded-sm text-primary underline decoration-primary/40 underline-offset-2 outline-none transition-colors hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring";

function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
    .join("");
}

/** A `../` link out of `docs/guide` to another file of the repository's docs. */
function repositoryDoc(href: string): string | undefined {
  const match = /^\.\.\/([\w./-]+\.md(?:#[\w-]+)?)$/.exec(href);
  if (match?.[1] === undefined || match[1].includes("..")) return undefined;
  return REPOSITORY_DOCS + match[1];
}

const components: Components = {
  ...markdownComponents,
  h2: ({ children }) => (
    <h2 id={headingId(textOf(children))} className="mt-8 mb-2 scroll-mt-16 text-heading first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 id={headingId(textOf(children))} className="mt-6 mb-1.5 scroll-mt-16 font-semibold">
      {children}
    </h3>
  ),
  a: ({ href, children }) => {
    const target = href ? guideLinkTarget(href) : undefined;
    if (target) {
      return (
        <Link
          to="/guide/$slug"
          params={{ slug: target.slug }}
          hash={target.hash}
          className={linkClass}
        >
          {children}
        </Link>
      );
    }
    if (href?.startsWith("#")) {
      return (
        <a href={href} className={linkClass}>
          {children}
        </a>
      );
    }
    const external = href ? (repositoryDoc(href) ?? href) : undefined;
    return (
      <a href={external} target="_blank" rel="noopener noreferrer" className={linkClass}>
        {children}
      </a>
    );
  },
  // Only the guide's own screenshots load; any other image shows its description.
  img: ({ src, alt }) => {
    const url = typeof src === "string" ? guideImageUrl(src) : undefined;
    if (url === undefined) return <span>{alt}</span>;
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="my-3 block">
        <img
          src={url}
          alt={alt ?? ""}
          loading="lazy"
          className="w-full rounded-md shadow-[0_0_0_1px_var(--border)]"
        />
      </a>
    );
  },
};

/** A guide page's markdown. Raw HTML is not rendered. */
export function GuideMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="min-w-0 break-words text-body text-foreground leading-relaxed">
      <ReactMarkdown remarkPlugins={markdownPlugins} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
