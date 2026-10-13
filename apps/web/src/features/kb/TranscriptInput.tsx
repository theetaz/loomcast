import { MAX_TRANSCRIPT_LENGTH } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Textarea } from "@loomcast/ui/components/textarea";
import { cn } from "@loomcast/ui/lib/cn";
import { FileUpIcon, ShieldCheckIcon } from "lucide-react";
import { type ChangeEvent, useRef, useState } from "react";
import {
  isTranscriptFileName,
  MAX_TRANSCRIPT_FILE_BYTES,
  parseTranscriptFile,
  TRANSCRIPT_FILE_EXTENSIONS,
} from "./transcript";

/** The fixed promise shown wherever a transcript is supplied. */
export const NO_DOWNLOAD_NOTICE =
  "Loomcast never downloads the video. Paste a transcript or load a file you own.";

export function NoDownloadNotice({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-md bg-accent-soft px-3 py-2 text-small text-foreground",
        className,
      )}
    >
      <ShieldCheckIcon aria-hidden="true" className="mt-px size-3.5 shrink-0 text-primary" />
      {NO_DOWNLOAD_NOTICE}
    </p>
  );
}

export interface TranscriptInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Ids of text that describes the field, such as an error. */
  describedBy?: string;
}

/**
 * A transcript, pasted or loaded from a `.txt`, `.srt`, `.vtt` or `.json` file the user picks.
 * Files are parsed in the browser into `[mm:ss] text` lines; nothing is uploaded or fetched.
 */
export function TranscriptInput({
  id,
  value,
  onChange,
  disabled = false,
  describedBy,
}: TranscriptInputProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [reading, setReading] = useState(false);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Let the same file be picked again after an edit.
    event.target.value = "";
    if (!file) return;
    if (!isTranscriptFileName(file.name)) {
      setStatus({ tone: "error", text: "Load a .txt, .srt, .vtt or .json transcript." });
      return;
    }
    if (file.size > MAX_TRANSCRIPT_FILE_BYTES) {
      setStatus({ tone: "error", text: `${file.name} is larger than 5 MB.` });
      return;
    }
    setReading(true);
    try {
      const result = parseTranscriptFile(file.name, await file.text());
      if (result.ok) {
        onChange(result.text);
        setStatus({
          tone: "info",
          text: `Loaded ${file.name}: ${result.lines.toLocaleString("en")} ${result.lines === 1 ? "line" : "lines"}.`,
        });
      } else {
        setStatus({ tone: "error", text: result.error });
      }
    } catch {
      setStatus({ tone: "error", text: `Couldn't read ${file.name}.` });
    } finally {
      setReading(false);
    }
  };

  const length = value.length;
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        id={id}
        value={value}
        disabled={disabled}
        maxLength={MAX_TRANSCRIPT_LENGTH}
        rows={8}
        spellCheck={false}
        placeholder={"[00:00] First line of the video\n[00:03] Next line…"}
        aria-describedby={[`${id}-status`, describedBy].filter(Boolean).join(" ")}
        className="max-h-[420px] min-h-40 font-mono text-[12.5px] leading-relaxed"
        onChange={(event) => {
          onChange(event.target.value);
          if (status?.tone === "error") setStatus(null);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept={TRANSCRIPT_FILE_EXTENSIONS.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void onFile(event)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || reading}
          onClick={() => fileRef.current?.click()}
        >
          <FileUpIcon aria-hidden="true" />
          {reading ? "Reading…" : "Load file"}
        </Button>
        <span className="text-small text-muted-foreground">
          .txt, .srt, .vtt or a .json word list
        </span>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums">
          {length.toLocaleString("en")} / {MAX_TRANSCRIPT_LENGTH.toLocaleString("en")}
        </span>
      </div>
      <p
        id={`${id}-status`}
        aria-live="polite"
        className={cn(
          "text-small empty:hidden",
          status?.tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {status?.text}
      </p>
    </div>
  );
}
