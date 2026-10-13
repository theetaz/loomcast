import type { Platform, PublishRequest } from "@loomcast/contracts";
import { buildFacebookPublish, validateFacebookRequest } from "./facebook";
import { buildInstagramPublish, validateInstagramRequest } from "./instagram";
import { buildThreadsPublish, validateThreadsRequest } from "./threads";
import type { MediaFacts, PlanInput, PublishPlan, RequestIssue } from "./types";
import { buildXPublish, validateXRequest } from "./x";

export * from "./facebook";
export * from "./instagram";
export * from "./threads";
export * from "./types";
export * from "./x";

const PLAN_BUILDERS: { readonly [P in Platform]: (input: PlanInput) => PublishPlan } = {
  instagram: buildInstagramPublish,
  facebook: buildFacebookPublish,
  threads: buildThreadsPublish,
  x: buildXPublish,
};

const VALIDATORS: {
  readonly [P in Platform]: (request: PublishRequest, media: MediaFacts) => RequestIssue[];
} = {
  instagram: validateInstagramRequest,
  facebook: validateFacebookRequest,
  threads: validateThreadsRequest,
  x: validateXRequest,
};

/** The requests a platform's `publish` sends for `input.request` (pure). */
export function buildPublishPlan(input: PlanInput): PublishPlan {
  return PLAN_BUILDERS[input.request.platform](input);
}

/** What the platform would refuse in `request` (pure; no network). */
export function validatePublishRequest(request: PublishRequest, media: MediaFacts): RequestIssue[] {
  return VALIDATORS[request.platform](request, media);
}
