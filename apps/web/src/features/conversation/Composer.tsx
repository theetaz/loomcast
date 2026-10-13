import { MAX_MESSAGE_TEXT_LENGTH } from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Textarea } from "@loomcast/ui/components/textarea";
import { cn } from "@loomcast/ui/lib/cn";
import { ArrowUpIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { SendVia } from "./messages";

/** The composer grows with its text up to this height, then scrolls. */
const MAX_HEIGHT = 200;
const SHOW_COUNT_FROM = MAX_MESSAGE_TEXT_LENGTH - 1_000;

const isApple =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

export interface ComposerProps {
  /** Each conversation keeps its own unsent text. */
  draftKey: string;
  /** Sends the text. The composer clears itself straight away; the message shows as pending. */
  onSend: (text: string, via: SendVia) => void;
  /** A send is waiting for the API to acknowledge it. */
  sending: boolean;
  /** Shown above the text box: the job status line. */
  status?: ReactNode;
  textareaRef?: Ref<HTMLTextAreaElement>;
  placeholder?: string;
}

/**
 * An auto-growing text box. ⌘Enter (Ctrl+Enter elsewhere) sends, Enter adds a
 * line. While a send waits for the API, sending is off but typing is not, so
 * focus and the next thought survive.
 */
export function Composer({
  draftKey,
  onSend,
  sending,
  status,
  textareaRef,
  placeholder = "Ask the studio agent to research a topic, draft a script or plan a video…",
}: ComposerProps) {
  const [text, setText] = useState("");
  const unsent = useRef(new Map<string, string>());
  const [shownKey, setShownKey] = useState(draftKey);
  if (shownKey !== draftKey) {
    // Another conversation: park this text and bring back the one typed there.
    unsent.current.set(shownKey, text);
    setShownKey(draftKey);
    setText(unsent.current.get(draftKey) ?? "");
  }
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const hintId = useId();
  const canSend = !sending && text.trim().length > 0;

  // Grow with the text. Measured before paint, so typing never flickers.
  useLayoutEffect(() => {
    const element = localRef.current;
    if (!element) return;
    element.style.height = "0px";
    const height = Math.min(element.scrollHeight, MAX_HEIGHT);
    element.style.height = `${height}px`;
    element.style.overflowY = element.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  function send(via: SendVia) {
    if (!canSend) return;
    onSend(text, via);
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      send("keyboard");
    }
  }

  function onClick(event: MouseEvent<HTMLButtonElement>) {
    // `detail` is 0 when Enter or Space pressed the button.
    send(event.detail === 0 ? "keyboard" : "pointer");
  }

  function setRefs(element: HTMLTextAreaElement | null) {
    localRef.current = element;
    if (typeof textareaRef === "function") textareaRef(element);
    else if (textareaRef) textareaRef.current = element;
  }

  const remaining = MAX_MESSAGE_TEXT_LENGTH - text.length;

  return (
    <div className="flex flex-col gap-2">
      {status}
      <form
        onSubmit={(event) => event.preventDefault()}
        className="flex flex-col rounded-lg bg-card shadow-card transition-shadow focus-within:shadow-focus"
      >
        <Textarea
          ref={setRefs}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          maxLength={MAX_MESSAGE_TEXT_LENGTH}
          aria-label="Message the studio agent"
          aria-describedby={hintId}
          placeholder={placeholder}
          className="field-sizing-fixed min-h-0 resize-none bg-transparent px-3 pt-2.5 pb-1 text-body shadow-none focus-visible:shadow-none"
        />
        <div className="flex items-center justify-between gap-2 py-1.5 pr-1.5 pl-3">
          <p id={hintId} className="min-w-0 truncate text-small text-text-4">
            {text.length >= SHOW_COUNT_FROM ? (
              <span className={cn(remaining <= 0 && "text-destructive")}>
                {remaining.toLocaleString("en")} characters left
              </span>
            ) : (
              <span className="[@media(pointer:coarse)]:sr-only">
                <kbd className="font-sans">{isApple ? "⌘" : "Ctrl"}</kbd>
                {isApple ? "" : "+"}
                <kbd className="font-sans">Enter</kbd> to send
              </span>
            )}
          </p>
          <Button
            type="button"
            size="sm"
            onClick={onClick}
            disabled={!canSend}
            aria-label={sending ? "Sending" : "Send message"}
          >
            <ArrowUpIcon aria-hidden="true" />
            <span aria-hidden="true">Send</span>
          </Button>
        </div>
      </form>
    </div>
  );
}
