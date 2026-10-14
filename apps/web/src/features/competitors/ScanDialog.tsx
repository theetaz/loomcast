import {
  COMPETITOR_SCAN_DEFAULT_VIDEOS,
  COMPETITOR_SCAN_MAX_VIDEOS,
  type Competitor,
  isPublicVideoUrl,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@loomcast/ui/components/dialog";
import { Label } from "@loomcast/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { Textarea } from "@loomcast/ui/components/textarea";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { platformLabel } from "@/features/channels/platforms";
import { errorMessage, isApiError } from "@/lib/api";
import { useStartScan } from "./queries";
import { competitorName } from "./status";

/** The sizes a scan offers; the default is the contracts' default. */
export const TOP_N_OPTIONS = [5, 10, 15, 20] as const;

/** The non-empty lines of `text`, with their line numbers. */
export function readLinks(text: string): { line: number; url: string }[] {
  return text
    .split(/\r?\n/)
    .map((url, index) => ({ line: index + 1, url: url.trim() }))
    .filter((entry) => entry.url.length > 0);
}

/** What is wrong with the pasted links, or null when they can be sent. */
export function linksError(competitor: Pick<Competitor, "platform">, text: string): string | null {
  const links = readLinks(text);
  const platform = platformLabel(competitor.platform);
  if (links.length === 0) {
    return competitor.platform === "instagram"
      ? null
      : `Paste at least one link to a ${platform} video.`;
  }
  if (links.length > COMPETITOR_SCAN_MAX_VIDEOS) {
    return `Paste at most ${COMPETITOR_SCAN_MAX_VIDEOS} links; this has ${links.length}.`;
  }
  const bad = links.find((entry) => !isPublicVideoUrl(entry.url, competitor.platform));
  if (bad) {
    return `Line ${bad.line} isn't a link to a single public ${platform} video.`;
  }
  return null;
}

/** Why the server would not start the scan, in words that say what to do next. */
export function scanErrorCopy(
  error: unknown,
  competitor: Pick<Competitor, "platform" | "handle">,
): ReactNode {
  if (!isApiError(error)) return errorMessage(error, "Couldn't start the scan. Try again.");
  switch (error.code) {
    case "not_professional_account":
      return `${competitorName(competitor)} isn't a business or creator account, so Instagram won't rank its Reels. Paste links to the videos you want analysed instead.`;
    case "no_instagram_channel":
      return (
        <>
          Ranking Reels by views needs a connected Instagram channel.{" "}
          <Link to="/settings/channels" className="underline underline-offset-2">
            Connect one in channel settings
          </Link>
          , or paste links to the videos instead.
        </>
      );
    case "links_required":
      return `${platformLabel(competitor.platform)} doesn't let Loomcast list a profile's videos. Paste links to the videos you want analysed.`;
    case "scan_in_progress":
      return "A scan of this competitor is already running. Wait for it to finish, or cancel it first.";
    default:
      return errorMessage(error, "Couldn't start the scan. Try again.");
  }
}

/** Wraps a trigger button. Starts a scan and opens it. */
export function ScanDialog({
  competitor,
  projectParam,
  children,
}: {
  competitor: Competitor;
  projectParam: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setFormKey((key) => key + 1);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <ScanForm
          key={formKey}
          competitor={competitor}
          projectParam={projectParam}
          onStarted={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ScanForm({
  competitor,
  projectParam,
  onStarted,
}: {
  competitor: Competitor;
  projectParam: string;
  onStarted: () => void;
}) {
  const id = useId();
  const navigate = useNavigate();
  const linksRef = useRef<HTMLTextAreaElement>(null);
  const start = useStartScan(competitor.id);
  const [topN, setTopN] = useState<number>(COMPETITOR_SCAN_DEFAULT_VIDEOS);
  const [links, setLinks] = useState("");
  const [linksProblem, setLinksProblem] = useState<string | null>(null);

  const instagram = competitor.platform === "instagram";
  const platform = platformLabel(competitor.platform);
  const pasted = readLinks(links);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (start.isPending) return;
    const problem = linksError(competitor, links);
    if (problem) {
      setLinksProblem(problem);
      linksRef.current?.focus();
      return;
    }
    const urls = pasted.map((entry) => entry.url);
    start.mutate(urls.length > 0 ? { topN: urls.length, links: urls } : { topN }, {
      onSuccess: (scan) => {
        onStarted();
        toast.success("Scan started", {
          description: `${scan.videoCount} ${scan.videoCount === 1 ? "video" : "videos"} of ${competitorName(competitor)} to analyse.`,
        });
        void navigate({
          to: "/projects/$projectId/competitors/$competitorId/scans/$scanId",
          params: { projectId: projectParam, competitorId: competitor.id, scanId: scan.id },
        });
      },
      onError: (error) => {
        if (isApiError(error) && error.code === "not_professional_account") {
          linksRef.current?.focus();
        }
      },
    });
  };

  const linksHintId = `${id}-links-hint`;
  const linksErrorId = `${id}-links-error`;

  return (
    <form noValidate onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Scan {competitorName(competitor)}</DialogTitle>
        <DialogDescription>
          The studio agent analyses each video, then writes a report to the knowledge base. Videos
          are deleted from the studio Mac after each analysis.
        </DialogDescription>
      </DialogHeader>

      {instagram ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-top`}>Videos to analyse</Label>
          <Select
            value={String(topN)}
            onValueChange={(value) => setTopN(Number(value))}
            disabled={pasted.length > 0}
          >
            <SelectTrigger id={`${id}-top`} className="w-full" aria-describedby={`${id}-top-hint`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TOP_N_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  Top {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p id={`${id}-top-hint`} className="text-small text-muted-foreground">
            {pasted.length > 0
              ? "Pasted links are analysed instead, in the order given."
              : "The most viewed Reels of the last 200 posts, through the official Instagram API."}
          </p>
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-links`}>
          Video links{" "}
          {instagram ? <span className="font-normal text-muted-foreground">(optional)</span> : null}
        </Label>
        <Textarea
          ref={linksRef}
          id={`${id}-links`}
          value={links}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          className="max-h-48 font-mono text-[12px]"
          placeholder={
            competitor.platform === "instagram"
              ? "https://www.instagram.com/reel/…"
              : competitor.platform === "facebook"
                ? "https://www.facebook.com/reel/…"
                : `https://www.threads.net/@${competitor.handle}/post/…`
          }
          aria-invalid={linksProblem ? true : undefined}
          aria-describedby={linksProblem ? `${linksErrorId} ${linksHintId}` : linksHintId}
          onChange={(event) => {
            setLinks(event.target.value);
            if (linksProblem) setLinksProblem(null);
          }}
        />
        {linksProblem ? (
          <p id={linksErrorId} className="text-small text-destructive">
            {linksProblem}
          </p>
        ) : null}
        <p id={linksHintId} className="text-small text-muted-foreground">
          {instagram
            ? `One per line, up to ${COMPETITOR_SCAN_MAX_VIDEOS}. Leave empty to rank by views.`
            : `One per line, up to ${COMPETITOR_SCAN_MAX_VIDEOS}. ${platform} doesn't let Loomcast list a profile's videos, so paste the ones to analyse.`}
        </p>
      </div>

      {start.error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {scanErrorCopy(start.error, competitor)}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={start.isPending}>
          {start.isPending ? "Starting…" : "Start scan"}
        </Button>
      </DialogFooter>
    </form>
  );
}
