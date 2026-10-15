import type { PostPerformance } from "@loomcast/contracts";
import { ScrollArea } from "@loomcast/ui/components/scroll-area";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import { engagementRate, formatDay, formatFullCount, formatRate } from "./format";
import { PLATFORM_LABELS, platformColor } from "./platforms";

/** A permalink a reader can open: platform links only, never `dryrun://`. */
export function openablePermalink(permalink: string | null): string | null {
  return permalink?.startsWith("https://") ? permalink : null;
}

export function PlatformLabel({ platform }: { platform: PostPerformance["platform"] }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ background: platformColor(platform) }}
      />
      {PLATFORM_LABELS[platform]}
    </span>
  );
}

/** The most-viewed posts of the range, most first, with a link to the video and the post. */
export function TopPostsTable({ posts }: { posts: readonly PostPerformance[] }) {
  return (
    <ScrollArea orientation="horizontal">
      <table className="w-full min-w-[620px] border-collapse text-control">
        <caption className="sr-only">Top posts by views</caption>
        <thead>
          <tr className="border-divider border-b text-small text-muted-foreground">
            <th scope="col" className="h-8 w-10 px-4 text-right font-medium">
              #
            </th>
            <th scope="col" className="h-8 px-2 text-left font-medium">
              Video
            </th>
            <th scope="col" className="h-8 px-2 text-left font-medium">
              Platform
            </th>
            <th scope="col" className="h-8 px-2 text-left font-medium">
              Published
            </th>
            <th scope="col" className="h-8 px-2 text-right font-medium">
              Views
            </th>
            <th scope="col" className="h-8 px-2 text-right font-medium">
              Engagement
            </th>
            <th scope="col" className="h-8 px-4 text-right font-medium">
              <span className="sr-only">Post</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {posts.map((post, index) => {
            const permalink = openablePermalink(post.permalink);
            return (
              <tr key={post.postId} className="border-divider border-b last:border-b-0">
                <td className="h-10 px-4 text-right text-muted-foreground tabular-nums">
                  {index + 1}
                </td>
                <th scope="row" className="h-10 max-w-[280px] px-2 text-left font-normal">
                  <Link
                    to="/content/$itemId"
                    params={{ itemId: post.itemId }}
                    className="block truncate text-foreground underline-offset-2 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                  >
                    {post.title}
                  </Link>
                </th>
                <td className="h-10 px-2 text-text-2">
                  <PlatformLabel platform={post.platform} />
                </td>
                <td className="h-10 px-2 whitespace-nowrap text-text-2">
                  {formatDay(Date.parse(post.publishedAt), true)}
                </td>
                <td className="h-10 px-2 text-right text-foreground tabular-nums">
                  {(post.metrics?.views ?? null) === null
                    ? "Not measured yet"
                    : formatFullCount(post.metrics?.views)}
                </td>
                <td className="h-10 px-2 text-right text-text-2 tabular-nums">
                  {formatRate(engagementRate(post.metrics))}
                </td>
                <td className="h-10 px-4 text-right">
                  {permalink ? (
                    <a
                      href={permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open “${post.title}” on ${PLATFORM_LABELS[post.platform]}`}
                      className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                    </a>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollArea>
  );
}
