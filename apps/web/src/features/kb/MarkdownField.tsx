import { MAX_KB_BODY_LENGTH } from "@loomcast/contracts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@loomcast/ui/components/tabs";
import { Textarea } from "@loomcast/ui/components/textarea";
import { useState } from "react";
import { Markdown } from "@/features/conversation/Markdown";

export interface MarkdownFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Markdown text with Write and Preview tabs. The preview is GitHub-flavoured markdown with raw
 * HTML shown as text, the same renderer as chat replies.
 */
export function MarkdownField({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled = false,
}: MarkdownFieldProps) {
  const [tab, setTab] = useState("write");
  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-2">
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="font-medium text-control">
          {label}
        </label>
        <TabsList aria-label={`${label} view`} className="ml-auto">
          <TabsTrigger value="write">Write</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="write" forceMount hidden={tab !== "write"}>
        <Textarea
          id={id}
          value={value}
          disabled={disabled}
          maxLength={MAX_KB_BODY_LENGTH}
          placeholder={placeholder}
          spellCheck
          className="min-h-[280px] font-mono text-[13px] leading-relaxed"
          onChange={(event) => onChange(event.target.value)}
        />
      </TabsContent>
      <TabsContent
        value="preview"
        className="min-h-[280px] rounded-md bg-card px-4 py-3 shadow-card"
      >
        {value.trim() ? (
          <Markdown text={value} className="max-w-[72ch]" />
        ) : (
          <p className="text-body text-muted-foreground">Nothing to preview yet.</p>
        )}
      </TabsContent>
    </Tabs>
  );
}
