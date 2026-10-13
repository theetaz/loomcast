import { Button } from "@loomcast/ui/components/button";
import { cn } from "@loomcast/ui/lib/cn";
import { CheckIcon, CopyIcon } from "lucide-react";
import {
  Children,
  type ComponentProps,
  isValidElement,
  memo,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

const COPIED_MS = 1_500;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      toast.error("Couldn't copy the code", {
        description: "Select it and copy it by hand instead.",
      });
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={() => void copy()}
      aria-label={copied ? "Copied" : "Copy code"}
      className="text-muted-foreground"
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
}

/** Text of the rendered `code` element inside a fenced block. */
function codeOf(children: ReactNode): { text: string; language?: string } {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    return { text: String(children ?? "") };
  }
  const language = /language-([\w+#.-]+)/.exec(child.props.className ?? "")?.[1];
  const text = Children.toArray(child.props.children)
    .map((part) => (typeof part === "string" || typeof part === "number" ? String(part) : ""))
    .join("")
    .replace(/\n$/, "");
  return { text, ...(language ? { language } : {}) };
}

function CodeBlock({ children }: ComponentProps<"pre">) {
  const { text, language } = codeOf(children);
  return (
    <div className="my-3 overflow-hidden rounded-md bg-secondary shadow-[0_0_0_1px_var(--border)] first:mt-0 last:mb-0">
      <div className="flex h-8 items-center justify-between gap-2 border-divider border-b pr-1 pl-3">
        <span className="truncate font-mono text-mono text-muted-foreground">
          {language ?? "code"}
        </span>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] text-foreground leading-relaxed">
        <code>{text}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  pre: CodeBlock,
  code: ({ className, children }) => (
    <code
      className={cn(
        "rounded-sm bg-secondary px-1 py-px font-mono text-[0.88em] text-foreground",
        className,
      )}
    >
      {children}
    </code>
  ),
  p: ({ children }) => <p className="my-2.5 first:mt-0 last:mb-0">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-sm text-primary underline decoration-primary/40 underline-offset-2 outline-none transition-colors hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </a>
  ),
  // Images would load from anywhere the text points; link to them instead.
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2"
      >
        {alt || "Image"}
      </a>
    ) : (
      <span>{alt}</span>
    ),
  ul: ({ children }) => (
    <ul className="my-2.5 list-disc space-y-1 pl-5 marker:text-text-4 first:mt-0 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol
      start={start}
      className="my-2.5 list-decimal space-y-1 pl-5 marker:text-muted-foreground first:mt-0 last:mb-0"
    >
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  h1: ({ children }) => <h3 className="mt-5 mb-2 text-heading first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-5 mb-2 text-heading first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-4 mb-1.5 font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-4 mb-1.5 font-semibold first:mt-0">{children}</h5>,
  h5: ({ children }) => <h6 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-3 mb-1 font-semibold first:mt-0">{children}</h6>,
  blockquote: ({ children }) => (
    <blockquote className="my-2.5 border-border border-l-2 pl-3 text-text-2 first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-divider" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-md shadow-[0_0_0_1px_var(--border)] first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-small">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="border-divider border-b bg-secondary px-2.5 py-1.5 text-left font-medium"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-divider border-b px-2.5 py-1.5 align-top">
      {children}
    </td>
  ),
};

const plugins = [remarkGfm];

/**
 * Assistant text as GitHub-flavoured markdown. Raw HTML is never rendered:
 * it shows as the text it is. Link targets go through react-markdown's URL
 * filter, which drops `javascript:` and other unsafe protocols.
 */
export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 break-words text-body text-foreground", className)}>
      <ReactMarkdown remarkPlugins={plugins} components={components} skipHtml={false}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
