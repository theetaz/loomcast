import type { KbEntryDetail } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileVideoIcon, ShieldCheckIcon, UploadIcon } from "lucide-react";
import { type DragEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import {
  checkReferenceFile,
  isAbortError,
  REFERENCE_MEDIA_ACCEPT,
  RIGHTS_NOTICE,
  StorageUploadError,
  type UploadProgress,
  type UploadStage,
  uploadReferenceMedia,
  type XhrFactory,
} from "./media-upload";
import { cacheKbEntry, kbKeys } from "./queries";

/** Where each step sits on the one progress bar. */
const STAGE_SPAN: Record<UploadStage, [number, number]> = {
  checksum: [0, 0.3],
  upload: [0.3, 0.9],
  verify: [0.9, 0.95],
  attach: [0.95, 0.97],
  analyze: [0.97, 1],
  done: [1, 1],
};

const STAGE_LABEL: Record<UploadStage, string> = {
  checksum: "Computing the checksum",
  upload: "Uploading",
  verify: "Verifying",
  attach: "Attaching to the reference",
  analyze: "Starting the analysis",
  done: "Done",
};

/** The share of the whole upload done, 0 to 1. */
export function overallShare({ stage, share }: UploadProgress): number {
  const [from, to] = STAGE_SPAN[stage];
  const value = from + (to - from) * Math.min(1, Math.max(0, share));
  return Math.round(value * 10_000) / 10_000;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof StorageUploadError) {
    return error.status === 0
      ? "The upload was interrupted. Check your connection and try again."
      : "Storage refused the upload. Try again in a moment.";
  }
  return errorMessage(error, "The upload failed. Try again.");
}

type State =
  | { kind: "idle"; error: string | null }
  | { kind: "busy"; file: File; progress: UploadProgress };

/**
 * Attaches the reference's own video or audio, so it can be analyzed without a transcript. The
 * file is hashed in the browser, uploaded straight to storage with progress, verified, attached
 * and analyzed. Leaving the page or pressing Cancel stops it. `createXhr` is for tests.
 */
export function ReferenceMediaUpload({
  entry,
  disabled = false,
  createXhr,
}: {
  entry: KbEntryDetail;
  disabled?: boolean;
  createXhr?: XhrFactory;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<State>({ kind: "idle", error: null });
  const [dragging, setDragging] = useState(false);
  const mediaAssetId = entry.reference?.mediaAssetId ?? null;
  const media = useQuery({
    queryKey: ["assets", "detail", mediaAssetId ?? ""],
    queryFn: ({ signal }) =>
      api.request("assets.get", { params: { id: mediaAssetId ?? "" }, signal }),
    enabled: mediaAssetId !== null,
    staleTime: 5 * 60_000,
  });

  useEffect(() => () => controller.current?.abort(), []);

  const start = async (file: File) => {
    const problem = checkReferenceFile(file);
    if (problem) {
      setState({ kind: "idle", error: problem });
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setState({ kind: "busy", file, progress: { stage: "checksum", share: 0 } });
    try {
      const result = await uploadReferenceMedia(file, entry, {
        signal: abort.signal,
        createXhr,
        onProgress: (progress) => setState({ kind: "busy", file, progress }),
      });
      queryClient.setQueryData(["assets", "detail", result.asset.id], {
        ...result.asset,
        alignment: null,
      });
      cacheKbEntry(queryClient, result.entry);
      if (result.job) {
        const job = result.job;
        queryClient.setQueryData(queryKeys.jobs.detail(job.id), job);
        queryClient.setQueryData<KbEntryDetail>(kbKeys.detail(entry.id), (current) =>
          current?.reference
            ? {
                ...current,
                reference: {
                  ...current.reference,
                  analysisJobId: job.id,
                  analysisStatus: "queued",
                },
              }
            : current,
        );
        toast.success("Media uploaded", { description: "The analysis has started." });
      } else {
        toast.success("Media uploaded", {
          description: `The analysis didn't start: ${errorMessage(result.analyzeError)}`,
        });
      }
      setState({ kind: "idle", error: null });
    } catch (error) {
      setState({
        kind: "idle",
        error: isAbortError(error) ? null : uploadErrorMessage(error),
      });
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  };

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void start(file);
    if (inputRef.current) inputRef.current.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (state.kind === "busy" || disabled) return;
    pick(event.dataTransfer.files);
  };

  const busy = state.kind === "busy";
  const share = busy ? overallShare(state.progress) : 0;
  const percent = Math.round(share * 100);

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-lg bg-card px-3.5 py-3 shadow-card"
    >
      <div className="flex flex-col gap-0.5">
        <h3 id={`${id}-title`} className="font-semibold text-[13px]">
          Media
        </h3>
        <p className="text-small text-muted-foreground">
          Upload the video or its audio to analyze it without a transcript. MP4, MOV, MP3, WAV or
          M4A, up to 1 GiB.
        </p>
      </div>

      {mediaAssetId && !busy ? (
        <div className="flex min-w-0 items-center gap-2.5 rounded-md bg-secondary px-2.5 py-2 shadow-[0_0_0_1px_var(--border)]">
          <FileVideoIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-control text-foreground">
              {media.data?.filename ?? (media.isPending ? "Attached media" : "Media file")}
            </span>
            {media.data ? (
              <span className="text-small text-muted-foreground tabular-nums">
                {formatBytes(media.data.bytes)}
                {media.data.status !== "ready" ? ` · ${media.data.status}` : ""}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {busy ? (
        <div className="flex flex-col gap-1.5" aria-busy="true">
          <div className="flex items-baseline gap-2 text-control">
            <span className="min-w-0 flex-1 truncate">
              <span className="text-foreground">{STAGE_LABEL[state.progress.stage]}</span>
              <span className="text-muted-foreground"> · {state.file.name}</span>
            </span>
            <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">
              {percent}%
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${STAGE_LABEL[state.progress.stage]}, ${percent}%`}
            className="h-1.5 overflow-hidden rounded-full bg-secondary shadow-[inset_0_0_0_1px_var(--border)]"
          >
            <div
              className="h-full origin-left rounded-full bg-primary transition-transform duration-150 ease-linear motion-reduce:transition-none"
              style={{ transform: `scaleX(${share})` }}
            />
          </div>
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => controller.current?.abort()}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for pointers; the upload button inside is the keyboard path.
        <div
          onDragOver={(event) => {
            if (disabled) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed px-3 py-2.5 transition-colors",
            dragging ? "border-primary bg-accent-soft" : "border-input",
          )}
        >
          <input
            ref={inputRef}
            id={`${id}-file`}
            type="file"
            accept={REFERENCE_MEDIA_ACCEPT}
            className="sr-only"
            disabled={disabled}
            aria-describedby={`${id}-rights`}
            onChange={(event) => pick(event.target.files)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <UploadIcon aria-hidden="true" />
            {mediaAssetId ? "Replace media" : "Upload media"}
          </Button>
          <span className="text-small text-muted-foreground">or drop a file here</span>
        </div>
      )}

      <p id={`${id}-rights`} className="flex items-start gap-1.5 text-small text-text-2">
        <ShieldCheckIcon
          aria-hidden="true"
          className="mt-px size-3.5 shrink-0 text-muted-foreground"
        />
        {RIGHTS_NOTICE}
      </p>

      {state.kind === "idle" && state.error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/8 px-2.5 py-2 text-small text-destructive"
        >
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
