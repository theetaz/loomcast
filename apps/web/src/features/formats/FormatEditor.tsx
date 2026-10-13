import {
  FORMAT_CTA_MAX_LENGTH,
  FORMAT_MAX_AVOID,
  FORMAT_MAX_TOPICS,
  FORMAT_NAME_MAX_LENGTH,
  FORMAT_NOTES_MAX_LENGTH,
  FORMAT_TONE_MAX_LENGTH,
  FORMAT_TOPIC_MAX_LENGTH,
  type Format,
  HASHTAG_MAX_LENGTH,
  LENGTH_SEC_MAX,
  LENGTH_SEC_MIN,
  MAX_HASHTAGS,
  READING_GRADE_MAX,
  READING_GRADE_MIN,
  type Series,
  VOICE_ID_MAX_LENGTH,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
} from "@loomcast/contracts";
import { Button } from "@loomcast/ui/components/button";
import { Input } from "@loomcast/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@loomcast/ui/components/select";
import { Switch } from "@loomcast/ui/components/switch";
import { Textarea } from "@loomcast/ui/components/textarea";
import { cn } from "@loomcast/ui/lib/cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Controller, FormProvider, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { useSaveShortcut } from "@/features/kb/use-save-shortcut";
import { errorMessage, isApiError } from "@/lib/api";
import { CadenceFields } from "./CadenceFields";
import { ChipsInput } from "./ChipsInput";
import { describedBy, EditorSection, Field } from "./Field";
import { diffJson } from "./json-diff";
import { PublishModeField } from "./PublishModeField";
import { formatQueryOptions, recipesQueryOptions, useUpdateFormat } from "./queries";
import {
  type FormatFormOutput,
  type FormatFormValues,
  fieldError,
  formatFormResolver,
  formValuesOf,
  invalidEntries,
  normalizeRules,
  optionalNumber,
  serverFieldErrors,
} from "./rules-form";
import {
  CAPTION_STYLE_IDS,
  CAPTION_STYLE_LABELS,
  HOOK_STYLE_IDS,
  HOOK_STYLE_LABELS,
  STYLE_OPTIONS,
  styleOption,
} from "./styles";

const NO_RECIPE = "__none";

/** A hashtag as typed (`#RustLang`, ` rust `) without its `#` and spaces, as it is stored. */
export function cleanHashtag(entry: string): string {
  return entry.trim().replace(/^#+/, "").trim();
}

interface Base {
  versionId: string;
  versionNo: number;
  values: FormatFormValues;
}

function baseOf(format: Format): Base {
  return {
    versionId: format.currentVersion.id,
    versionNo: format.currentVersion.versionNo,
    values: formValuesOf(format.name, format.currentVersion.rules),
  };
}

/**
 * Edits a format's name and rules. The form checks everything with the contracts' schemas before
 * it saves, and every save stores a new version on top of the one the edit started from: when
 * someone else saved first, the API answers 409 and the editor offers to load their version or
 * save over it. ⌘S or Ctrl+S saves.
 */
export function FormatEditor({
  format,
  usedBy,
  readOnly = false,
}: {
  format: Format;
  usedBy: readonly Series[];
  readOnly?: boolean;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const update = useUpdateFormat();
  const recipes = useQuery(recipesQueryOptions());
  const [base, setBase] = useState<Base>(() => baseOf(format));
  const [conflict, setConflict] = useState<FormatFormOutput | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const methods = useForm<FormatFormValues, unknown, FormatFormOutput>({
    resolver: formatFormResolver,
    defaultValues: base.values,
    mode: "onSubmit",
    reValidateMode: "onChange",
  });
  const {
    control,
    register,
    reset,
    setError,
    handleSubmit,
    formState: { errors, isDirty, submitCount },
  } = methods;

  // A version saved elsewhere replaces an untouched form; edits in progress are kept.
  const serverVersionId = format.currentVersion.id;
  useEffect(() => {
    if (serverVersionId === base.versionId || isDirty || update.isPending) return;
    const next = baseOf(format);
    setBase(next);
    reset(next.values);
  }, [serverVersionId, base.versionId, isDirty, update.isPending, format, reset]);

  const stale = serverVersionId !== base.versionId;

  const save = (output: FormatFormOutput, baseVersionId: string) => {
    const nameChanged = output.name !== base.values.name;
    const rulesChanged = diffJson(normalizeRules(base.values.rules), output.rules).length > 0;
    if (!nameChanged && !rulesChanged && baseVersionId === base.versionId) {
      reset(base.values);
      return;
    }
    update.mutate(
      {
        format,
        baseVersionId,
        ...(nameChanged ? { name: output.name } : {}),
        ...(rulesChanged || baseVersionId !== base.versionId ? { rules: output.rules } : {}),
      },
      {
        onSuccess: (saved) => {
          const next = baseOf(saved);
          setBase(next);
          setConflict(null);
          reset(next.values);
          toast.success(`Saved as version ${saved.currentVersion.versionNo}`, {
            description: saved.name,
          });
        },
        onError: (error) => {
          if (isApiError(error, 409)) {
            setConflict(output);
            return;
          }
          const fields = serverFieldErrors(error);
          if (fields.length > 0) {
            for (const field of fields) {
              setError(field.name as never, { type: "server", message: field.message });
            }
            return;
          }
          toast.error("Couldn't save the format", { description: errorMessage(error) });
        },
      },
    );
  };

  const submit = handleSubmit((output) => save(output, base.versionId));
  useSaveShortcut(() => {
    if (!readOnly) void submit();
  }, !readOnly);

  const loadLatest = async () => {
    const latest = await queryClient.fetchQuery({ ...formatQueryOptions(format.id), staleTime: 0 });
    const next = baseOf(latest);
    setBase(next);
    setConflict(null);
    reset(next.values);
  };

  const saveOver = async () => {
    if (!conflict) return;
    const latest = await queryClient.fetchQuery({ ...formatQueryOptions(format.id), staleTime: 0 });
    save(conflict, latest.currentVersion.id);
  };

  const styleId = useWatch({ control, name: "rules.visualTemplate.styleId" });
  const recipeName = useWatch({ control, name: "rules.recipe.name" });
  const hookStyle = useWatch({ control, name: "rules.hookStyle" });
  const captionsOn = useWatch({ control, name: "rules.visualTemplate.captions.enabled" });
  const recipeList = recipes.data ?? [];
  const chosenRecipe = recipeList.find((recipe) => recipe.name === recipeName);
  const style = styleOption(styleId);
  const errorCount = countErrors(errors);

  const ids = {
    name: `${id}-name`,
    tone: `${id}-tone`,
    grade: `${id}-grade`,
    hook: `${id}-hook`,
    hookNotes: `${id}-hook-notes`,
    min: `${id}-min`,
    max: `${id}-max`,
    voice: `${id}-voice`,
    speed: `${id}-speed`,
    style: `${id}-style`,
    template: `${id}-template`,
    recipe: `${id}-recipe`,
    captions: `${id}-captions`,
    captionStyle: `${id}-caption-style`,
    topics: `${id}-topics`,
    avoid: `${id}-avoid`,
    hashtags: `${id}-hashtags`,
    cta: `${id}-cta`,
  };
  const err = (name: string) => fieldError(errors, name);

  return (
    <FormProvider {...methods}>
      <form
        ref={formRef}
        noValidate
        onSubmit={submit}
        aria-label="Format rules"
        className="flex flex-col gap-4"
      >
        {stale && !conflict ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-status-amber/11 px-3.5 py-2.5 text-control text-foreground"
          >
            <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-status-amber" />
            <span className="min-w-0 flex-1">
              Version {format.currentVersion.versionNo} was saved while you were editing.
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadLatest()}>
              Discard my changes and load it
            </Button>
          </div>
        ) : null}
        {conflict ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-destructive/8 px-3.5 py-2.5 text-control text-foreground"
          >
            <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1">
              This format changed since you opened it. Load the newer version, or save yours on top
              of it.
            </span>
            <div className="flex gap-1.5">
              <Button type="button" variant="outline" size="sm" onClick={() => void loadLatest()}>
                Load newer version
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={update.isPending}
                onClick={() => void saveOver()}
              >
                Save mine over it
              </Button>
            </div>
          </div>
        ) : null}

        <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4">
          <EditorSection
            id={`${id}-about`}
            title="Format"
            description={
              usedBy.length > 1
                ? `Shared by ${usedBy.length} series: ${usedBy.map((series) => series.name).join(", ")}. Changes apply to all of them.`
                : "The rules every video of the series follows. Saving stores a new version; videos already produced keep the version they used."
            }
          >
            <Field id={ids.name} label="Name" error={err("name")}>
              <Input
                id={ids.name}
                autoComplete="off"
                maxLength={FORMAT_NAME_MAX_LENGTH}
                aria-invalid={err("name") ? true : undefined}
                aria-describedby={describedBy(ids.name, false, err("name"))}
                className="max-w-md"
                {...register("name")}
              />
            </Field>
          </EditorSection>

          <EditorSection
            id={`${id}-script`}
            title="Script"
            description="How the studio agent writes: the voice, the reading level and how each video opens."
          >
            <Field
              id={ids.tone}
              label="Tone"
              hint={`Up to ${FORMAT_TONE_MAX_LENGTH} characters.`}
              error={err("rules.tone")}
            >
              <Textarea
                id={ids.tone}
                rows={2}
                maxLength={FORMAT_TONE_MAX_LENGTH}
                aria-invalid={err("rules.tone") ? true : undefined}
                aria-describedby={describedBy(ids.tone, true, err("rules.tone"))}
                {...register("rules.tone")}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
              <Field
                id={ids.grade}
                label="Reading grade"
                hint={`${READING_GRADE_MIN} to ${READING_GRADE_MAX}`}
                error={err("rules.readingLevel.grade")}
              >
                <Input
                  id={ids.grade}
                  type="number"
                  inputMode="numeric"
                  min={READING_GRADE_MIN}
                  max={READING_GRADE_MAX}
                  step={1}
                  className="w-24 tabular-nums"
                  aria-invalid={err("rules.readingLevel.grade") ? true : undefined}
                  aria-describedby={describedBy(ids.grade, true, err("rules.readingLevel.grade"))}
                  {...register("rules.readingLevel.grade", { valueAsNumber: true })}
                />
              </Field>
              <Controller
                control={control}
                name="rules.hookStyle"
                render={({ field }) => (
                  <Field
                    id={ids.hook}
                    label="Hook style"
                    hint={HOOK_STYLE_LABELS[hookStyle as keyof typeof HOOK_STYLE_LABELS]?.hint}
                    error={err("rules.hookStyle")}
                  >
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger
                        id={ids.hook}
                        ref={field.ref}
                        className="w-full max-w-xs"
                        aria-describedby={describedBy(ids.hook, true, err("rules.hookStyle"))}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {HOOK_STYLE_IDS.map((hook) => (
                          <SelectItem key={hook} value={hook}>
                            {HOOK_STYLE_LABELS[hook].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
            </div>
            <Field id={ids.hookNotes} label="Hook notes" optional error={err("rules.hookNotes")}>
              <Textarea
                id={ids.hookNotes}
                rows={2}
                maxLength={FORMAT_NOTES_MAX_LENGTH}
                placeholder="Show the error message in the first second."
                aria-invalid={err("rules.hookNotes") ? true : undefined}
                {...register("rules.hookNotes")}
              />
            </Field>
          </EditorSection>

          <EditorSection
            id={`${id}-length`}
            title="Length"
            description={`How long each video runs, between ${LENGTH_SEC_MIN} and ${LENGTH_SEC_MAX} seconds.`}
          >
            <div className="flex flex-wrap gap-4">
              <Field id={ids.min} label="Shortest (seconds)" error={err("rules.lengthSec.min")}>
                <Input
                  id={ids.min}
                  type="number"
                  inputMode="numeric"
                  min={LENGTH_SEC_MIN}
                  max={LENGTH_SEC_MAX}
                  step={1}
                  className="w-28 tabular-nums"
                  aria-invalid={err("rules.lengthSec.min") ? true : undefined}
                  aria-describedby={describedBy(ids.min, false, err("rules.lengthSec.min"))}
                  {...register("rules.lengthSec.min", {
                    valueAsNumber: true,
                    // The range error sits on the longest length; re-check it as either changes.
                    deps: ["rules.lengthSec.max"],
                  })}
                />
              </Field>
              <Field id={ids.max} label="Longest (seconds)" error={err("rules.lengthSec.max")}>
                <Input
                  id={ids.max}
                  type="number"
                  inputMode="numeric"
                  min={LENGTH_SEC_MIN}
                  max={LENGTH_SEC_MAX}
                  step={1}
                  className="w-28 tabular-nums"
                  aria-invalid={err("rules.lengthSec.max") ? true : undefined}
                  aria-describedby={describedBy(ids.max, false, err("rules.lengthSec.max"))}
                  {...register("rules.lengthSec.max", {
                    valueAsNumber: true,
                    deps: ["rules.lengthSec.min"],
                  })}
                />
              </Field>
            </div>
          </EditorSection>

          <EditorSection
            id={`${id}-voice`}
            title="Voice"
            description="The TTS provider's voice. Without one, production stops before the voice step."
          >
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)]">
              <Field id={ids.voice} label="Voice ID" optional error={err("rules.voiceId")}>
                <Input
                  id={ids.voice}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={VOICE_ID_MAX_LENGTH}
                  className="font-mono text-[12px]"
                  aria-invalid={err("rules.voiceId") ? true : undefined}
                  {...register("rules.voiceId")}
                />
              </Field>
              <Field
                id={ids.speed}
                label="Speed"
                optional
                hint={`${VOICE_SPEED_MIN} to ${VOICE_SPEED_MAX}; 1 is normal.`}
                error={err("rules.voiceSpeed")}
              >
                <Input
                  id={ids.speed}
                  type="number"
                  inputMode="decimal"
                  min={VOICE_SPEED_MIN}
                  max={VOICE_SPEED_MAX}
                  step={0.05}
                  placeholder="1"
                  className="w-24 tabular-nums"
                  aria-invalid={err("rules.voiceSpeed") ? true : undefined}
                  aria-describedby={describedBy(ids.speed, true, err("rules.voiceSpeed"))}
                  {...register("rules.voiceSpeed", { setValueAs: optionalNumber })}
                />
              </Field>
            </div>
          </EditorSection>

          <EditorSection
            id={`${id}-visuals`}
            title="Visuals"
            description="The style from the studio's style library, the recipe that guides production, and captions."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                control={control}
                name="rules.visualTemplate.styleId"
                render={({ field }) => (
                  <Field
                    id={ids.style}
                    label="Style"
                    hint={style?.hint ?? "A style id from the studio's style library."}
                    error={err("rules.visualTemplate.styleId")}
                  >
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger
                        id={ids.style}
                        ref={field.ref}
                        className="w-full"
                        aria-describedby={describedBy(
                          ids.style,
                          true,
                          err("rules.visualTemplate.styleId"),
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STYLE_OPTIONS.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.name}
                          </SelectItem>
                        ))}
                        {styleOption(field.value) || !field.value ? null : (
                          <SelectItem value={field.value}>{field.value}</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
              <Controller
                control={control}
                name="rules.recipe"
                render={({ field }) => (
                  <Field
                    id={ids.recipe}
                    label="Recipe"
                    optional
                    hint={
                      chosenRecipe?.description ??
                      (recipes.isError
                        ? "Couldn't load the recipes."
                        : "A recipe skill strings the production steps together for this kind of video.")
                    }
                    error={err("rules.recipe.name")}
                  >
                    <Select
                      value={field.value?.name || NO_RECIPE}
                      onValueChange={(value) =>
                        field.onChange(
                          value === NO_RECIPE
                            ? undefined
                            : value === field.value?.name
                              ? field.value
                              : { name: value },
                        )
                      }
                    >
                      <SelectTrigger id={ids.recipe} ref={field.ref} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_RECIPE}>No recipe</SelectItem>
                        {recipeList.map((recipe) => (
                          <SelectItem key={recipe.name} value={recipe.name}>
                            {recipe.name}
                          </SelectItem>
                        ))}
                        {field.value?.name &&
                        !recipeList.some((recipe) => recipe.name === field.value?.name) ? (
                          <SelectItem value={field.value.name}>{field.value.name}</SelectItem>
                        ) : null}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
            </div>
            <Field
              id={ids.template}
              label="Layout template"
              optional
              hint="A card id within the style. Leave it empty to let the studio pick."
              error={err("rules.visualTemplate.templateId")}
            >
              <Input
                id={ids.template}
                autoComplete="off"
                spellCheck={false}
                placeholder={`${styleId || "style"}.t1.section.circle`}
                className="max-w-md font-mono text-[12px]"
                aria-invalid={err("rules.visualTemplate.templateId") ? true : undefined}
                aria-describedby={describedBy(
                  ids.template,
                  true,
                  err("rules.visualTemplate.templateId"),
                )}
                {...register("rules.visualTemplate.templateId")}
              />
            </Field>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
              <Controller
                control={control}
                name="rules.visualTemplate.captions.enabled"
                render={({ field }) => (
                  <div className="flex items-center gap-2.5">
                    <Switch
                      id={ids.captions}
                      ref={field.ref}
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                    <label
                      htmlFor={ids.captions}
                      className="font-medium text-control text-foreground"
                    >
                      Burned-in captions
                    </label>
                  </div>
                )}
              />
              <Controller
                control={control}
                name="rules.visualTemplate.captions.style"
                render={({ field }) => (
                  <Field
                    id={ids.captionStyle}
                    label="Caption style"
                    className={cn(!captionsOn && "opacity-60")}
                    error={err("rules.visualTemplate.captions.style")}
                  >
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id={ids.captionStyle} ref={field.ref} className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CAPTION_STYLE_IDS.map((captionStyle) => (
                          <SelectItem key={captionStyle} value={captionStyle}>
                            {CAPTION_STYLE_LABELS[captionStyle].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
            </div>
          </EditorSection>

          <EditorSection
            id={`${id}-topics`}
            title="Topics"
            description="Where new ideas come from, and what the studio agent must stay away from. Paste several lines to add one per line."
          >
            <Controller
              control={control}
              name="rules.topicPool"
              render={({ field }) => (
                <Field id={ids.topics} label="Topic pool" error={err("rules.topicPool")}>
                  <ChipsInput
                    id={ids.topics}
                    noun="topic"
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    placeholder="Type a topic and press Enter"
                    max={FORMAT_MAX_TOPICS}
                    maxLength={FORMAT_TOPIC_MAX_LENGTH}
                    invalid={invalidEntries(errors, "rules.topicPool")}
                    hasError={Boolean(err("rules.topicPool"))}
                    describedBy={describedBy(ids.topics, false, err("rules.topicPool"))}
                  />
                </Field>
              )}
            />
            <Controller
              control={control}
              name="rules.avoid"
              render={({ field }) => (
                <Field id={ids.avoid} label="Avoid" error={err("rules.avoid")}>
                  <ChipsInput
                    id={ids.avoid}
                    noun="avoided topic"
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    placeholder="Words, claims or topics to leave out"
                    max={FORMAT_MAX_AVOID}
                    maxLength={FORMAT_TOPIC_MAX_LENGTH}
                    invalid={invalidEntries(errors, "rules.avoid")}
                    hasError={Boolean(err("rules.avoid"))}
                    describedBy={describedBy(ids.avoid, false, err("rules.avoid"))}
                  />
                </Field>
              )}
            />
          </EditorSection>

          <CadenceFields />

          <EditorSection
            id={`${id}-publishing`}
            title="Publishing"
            description="Whether videos wait for approval, and what every caption ends with."
          >
            <PublishModeField />
            <Controller
              control={control}
              name="rules.caption.hashtags"
              render={({ field }) => (
                <Field
                  id={ids.hashtags}
                  label="Hashtags"
                  hint="Letters, digits and underscores. The # is added when posting."
                  error={err("rules.caption.hashtags")}
                >
                  <ChipsInput
                    id={ids.hashtags}
                    noun="hashtag"
                    prefix="#"
                    clean={cleanHashtag}
                    ignoreCase
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    placeholder="#rustlang"
                    max={MAX_HASHTAGS}
                    maxLength={HASHTAG_MAX_LENGTH + 1}
                    invalid={invalidEntries(errors, "rules.caption.hashtags")}
                    hasError={Boolean(err("rules.caption.hashtags"))}
                    describedBy={describedBy(ids.hashtags, true, err("rules.caption.hashtags"))}
                  />
                </Field>
              )}
            />
            <Field id={ids.cta} label="Call to action" optional error={err("rules.caption.cta")}>
              <Input
                id={ids.cta}
                autoComplete="off"
                maxLength={FORMAT_CTA_MAX_LENGTH}
                placeholder="Follow for one Rust error a day."
                aria-invalid={err("rules.caption.cta") ? true : undefined}
                {...register("rules.caption.cta")}
              />
            </Field>
          </EditorSection>
        </fieldset>

        {readOnly ? null : (
          <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-popover px-3.5 py-2.5 shadow-pop">
            <p aria-live="polite" className="min-w-0 flex-1 text-control">
              {errorCount > 0 && submitCount > 0 ? (
                <span className="text-destructive">
                  Fix {errorCount === 1 ? "one field" : `${errorCount} fields`} to save.
                </span>
              ) : isDirty ? (
                <span className="text-foreground">
                  Unsaved changes.{" "}
                  <span className="text-muted-foreground">
                    Saving creates version {base.versionNo + 1}.
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">
                  Version {base.versionNo}. No unsaved changes.
                </span>
              )}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!isDirty || update.isPending}
              onClick={() => {
                reset(base.values);
                setConflict(null);
              }}
            >
              Discard
            </Button>
            <Button type="submit" size="sm" disabled={!isDirty || update.isPending}>
              {update.isPending ? "Saving…" : "Save version"}
            </Button>
          </div>
        )}
      </form>
    </FormProvider>
  );
}

/** Fields with an error, counting a list with bad entries once. */
function countErrors(errors: object): number {
  let count = 0;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (typeof (node as { message?: unknown }).message === "string" || Array.isArray(node)) {
      count += 1;
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "ref" || key === "type" || key === "types") continue;
      visit(value);
    }
  };
  visit(errors);
  return count;
}
