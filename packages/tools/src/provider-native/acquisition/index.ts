import type { ProviderNativeHttpToolDefinition } from "../core.ts";
import { browserbaseNativeHttpToolDefinitions } from "./browserbase.ts";
import { demioNativeHttpToolDefinitions } from "./demio.ts";
import { firecrawlNativeHttpToolDefinitions } from "./firecrawl.ts";
import { firehoseNativeHttpToolDefinitions } from "./firehose.ts";
import { hotjarNativeHttpToolDefinitions } from "./hotjar.ts";
import { linkedinAdsNativeHttpToolDefinitions } from "./linkedin-ads.ts";
import { mailchimpNativeHttpToolDefinitions } from "./mailchimp.ts";
import { plausibleNativeHttpToolDefinitions } from "./plausible.ts";
import { postmarkNativeHttpToolDefinitions } from "./postmark.ts";
import { rankparseNativeHttpToolDefinitions } from "./rankparse.ts";
import { savvycalNativeHttpToolDefinitions } from "./savvycal.ts";
import { segmentNativeHttpToolDefinitions } from "./segment.ts";
import { sendgridNativeHttpToolDefinitions } from "./sendgrid.ts";
import { strapiNativeHttpToolDefinitions } from "./strapi.ts";

export const expandedAcquisitionNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] =
  [
    ...segmentNativeHttpToolDefinitions,
    ...plausibleNativeHttpToolDefinitions,
    ...rankparseNativeHttpToolDefinitions,
    ...savvycalNativeHttpToolDefinitions,
    ...mailchimpNativeHttpToolDefinitions,
    ...sendgridNativeHttpToolDefinitions,
    ...postmarkNativeHttpToolDefinitions,
    ...firecrawlNativeHttpToolDefinitions,
    ...browserbaseNativeHttpToolDefinitions,
    ...linkedinAdsNativeHttpToolDefinitions,
    ...hotjarNativeHttpToolDefinitions,
    ...firehoseNativeHttpToolDefinitions,
    ...demioNativeHttpToolDefinitions,
    ...strapiNativeHttpToolDefinitions,
  ];

export type DeferredAcquisitionDescriptor = {
  readonly classification: "deferred";
  readonly provider: string;
  readonly reason: string;
  readonly route: "platform_api_credential" | "mcp_gateway" | "platform_oauth";
  readonly sourceGuide: string;
};

export const EXPANDED_ACQUISITION_DEFERRED_DESCRIPTORS: readonly DeferredAcquisitionDescriptor[] =
  Object.freeze([]);
