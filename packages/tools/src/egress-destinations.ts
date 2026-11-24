import {
  normalizeEgressOrigin,
  type EgressDestination,
  type EgressDestinations,
} from "@deployments-ai/db";
import { APP_TOOL_NAMES } from "./apps.ts";
import { CODE_EXECUTE_TOOL_NAME } from "./code.ts";
import { COMPUTER_TOOL_NAMES } from "./computer.ts";
import { toolEgress } from "./egress.ts";
import { SANDBOX_FILE_TOOL_NAMES } from "./sandbox-files.ts";
import type { ToolAdapterDefinition } from "./types.ts";
import { SELF_HOSTED_WEB_SCRAPE_OPTION_NAMES } from "./web.ts";

type ToolInput = Readonly<Record<string, unknown>>;
type Extractor = (input: ToolInput) => EgressDestinations;

const WEB_TOOLS_LLM = "This call uses the web tools LLM, which is not inside the boundary.";

/**
 * Public tools whose calls never get a per-call decision, with the reason a restricted boundary
 * denies them. A runtime never advertises them inside such a boundary.
 */
export const ALWAYS_UNKNOWN_EGRESS_TOOLS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    APP_TOOL_NAMES.map((toolName) => [
      toolName,
      "App tools build, query, or publish an app whose visitors and requests the input does not name.",
    ]),
  ),
  "artifact.share": "A share link can be opened by anyone who holds it.",
  [CODE_EXECUTE_TOOL_NAME]:
    "Model-written code can reach network destinations that its input does not name.",
  ...Object.fromEntries(
    COMPUTER_TOOL_NAMES.map((toolName) => [
      toolName,
      "The sandbox desktop runs apps, such as a browser or terminal, that can reach destinations no input names.",
    ]),
  ),
  ...Object.fromEntries(
    SANDBOX_FILE_TOOL_NAMES.map((toolName) => [
      toolName,
      "Sandbox files are reachable by sandbox code, which can send them to destinations no input names.",
    ]),
  ),
  "web.crawl_params_preview": `Every call asks the web tools LLM to turn the prompt into crawl options. ${WEB_TOOLS_LLM}`,
  "web.deep_research": `Deep research crawls pages an LLM picks. ${WEB_TOOLS_LLM}`,
  "web.extract": `Every extraction asks the web tools LLM to analyze the schema or prompt. ${WEB_TOOLS_LLM}`,
  "web.generate_llms_txt": `Every call asks the web tools LLM to describe each page. ${WEB_TOOLS_LLM}`,
  "web.parse":
    "Parsing names no destination to approve, and its LLM-backed options send the artifact to the web tools LLM.",
};

const unknown = (reason: string): EgressDestinations => ({
  kind: "unknown",
  reason,
});
const known = (destinations: readonly EgressDestination[]): EgressDestinations => ({
  destinations,
  kind: "known",
});

/** The first unknown result wins; otherwise every destination, in order. */
function merge(...results: readonly EgressDestinations[]): EgressDestinations {
  const destinations: EgressDestination[] = [];
  for (const result of results) {
    if (result.kind === "unknown") return result;
    destinations.push(...result.destinations);
  }
  return known(destinations);
}

function record(value: unknown): ToolInput | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ToolInput)
    : undefined;
}

const NON_CANONICAL_URL_CHARACTER = /[\\\s\p{Cc}]/u;

/**
 * Providers receive the raw string, and their URL parsers can read a host the WHATWG parser does
 * not (`https://a.example\@b.example/`), so a URL counts only in the canonical form the parser
 * prints back, optionally without the root path's trailing slash.
 */
function canonicalUrl(raw: string): boolean {
  if (NON_CANONICAL_URL_CHARACTER.test(raw)) return false;
  try {
    const { href } = new URL(raw);
    return href === raw || href === `${raw}/`;
  } catch {
    return false;
  }
}

function urlAt(value: unknown, field: string): EgressDestinations {
  const url = typeof value === "string" ? value : "";
  const origin = canonicalUrl(url) ? normalizeEgressOrigin(url) : undefined;
  return origin
    ? known([{ kind: "url", origin, url }])
    : unknown(`${field} is not a canonical https URL without credentials.`);
}

function urlsAt(value: unknown, field: string): EgressDestinations {
  if (!Array.isArray(value) || value.length === 0) {
    return unknown(`${field} must list at least one URL.`);
  }
  return merge(...value.map((entry, index) => urlAt(entry, `${field}[${index}]`)));
}

function optionalUrlAt(value: unknown, field: string): EgressDestinations {
  return value === undefined || (typeof value === "string" && !value.trim())
    ? known([])
    : urlAt(value, field);
}

const E164 = /^\+[1-9]\d{6,14}$/u;
const EMAIL = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/u;

function recipientAt(value: unknown, field: string, pattern: RegExp): EgressDestinations {
  const address = typeof value === "string" ? value.trim() : "";
  return pattern.test(address)
    ? known([{ address, kind: "recipient" }])
    : unknown(`${field} is not a recipient address this boundary can read.`);
}

/**
 * Firecrawl output formats that the pinned self-hosted image computes from the page alone.
 * Every other format (json, summary, changeTracking, question, query, highlights, branding,
 * deterministicJson, product, menu, audio, video) calls a model or another service.
 */
const PAGE_ONLY_FORMATS = new Set([
  "attributes",
  "html",
  "images",
  "links",
  "markdown",
  "rawHtml",
  "screenshot",
]);
/** Firecrawl request keys that hand the page or the prompt to a model. */
const LLM_OPTION_KEYS = [
  "agent",
  "changeTrackingOptions",
  "extract",
  "jsonOptions",
  "prompt",
  "schema",
  "systemPrompt",
] as const;

function formatsUseLlm(formats: unknown): boolean {
  if (formats === undefined) return false;
  if (!Array.isArray(formats)) return true;
  return formats.some((format) => {
    if (typeof format === "string") return !PAGE_ONLY_FORMATS.has(format);
    const object = record(format);
    return (
      !object ||
      typeof object.type !== "string" ||
      !PAGE_ONLY_FORMATS.has(object.type) ||
      "prompt" in object ||
      "schema" in object
    );
  });
}

/**
 * Why a Firecrawl request cannot be judged from its input, searching the request and its nested
 * `options`, `scrapeOptions`, and `body` objects: LLM-backed output, or interactive actions that
 * can run script on the page.
 */
function firecrawlRequestUnknown(container: unknown, field: string): string | undefined {
  if (container === undefined) return undefined;
  const object = record(container);
  if (!object) return `${field} is not an object this boundary can read.`;
  if (
    formatsUseLlm(object.formats) ||
    LLM_OPTION_KEYS.some((key) => object[key] !== undefined) ||
    (object.onlyCleanContent !== undefined && object.onlyCleanContent !== false) ||
    (object.highlights !== undefined && object.highlights !== false)
  ) {
    return WEB_TOOLS_LLM;
  }
  if (object.actions !== undefined) {
    return `${field}.actions can run script that reaches destinations the input does not name.`;
  }
  for (const nested of ["options", "scrapeOptions", "body"] as const) {
    const reason = firecrawlRequestUnknown(object[nested], `${field}.${nested}`);
    if (reason) return reason;
  }
  return undefined;
}

/** The request's own destinations, unless the request cannot be judged from its input. */
function firecrawlRequest(input: ToolInput, destinations: EgressDestinations) {
  const reason = firecrawlRequestUnknown(input, "input");
  return reason ? unknown(reason) : destinations;
}

/**
 * A crawl follows links on the start URL's host, which the site chooses, like a browser's
 * subresources. Following links to other hosts reaches hosts the input does not name.
 */
function crawlTargets(input: ToolInput): EgressDestinations {
  const options = record(input.options);
  for (const key of ["allowExternalLinks", "allowSubdomains"] as const) {
    if (input[key] === true || options?.[key] === true) {
      return unknown(`${key} follows links to hosts the input does not name.`);
    }
  }
  return urlAt(input.url, "url");
}

/** Search results are scraped only when scrapeOptions requests formats; their URLs are unknown. */
function searchScrapesResults(input: ToolInput): EgressDestinations {
  const options = record(input.options);
  for (const scrapeOptions of [input.scrapeOptions, options?.scrapeOptions]) {
    const formats = record(scrapeOptions)?.formats;
    if (formats !== undefined && (!Array.isArray(formats) || formats.length > 0)) {
      return unknown("Scraping search results reaches pages the input does not name.");
    }
  }
  return known([]);
}

function domainList(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value.map((entry) => entry.trim().toLowerCase())
    : undefined;
}

/**
 * The text search engines receive: the query with Firecrawl's domain filters appended. Category
 * filters add only fixed text, so they are left out.
 */
function searchQuery(input: ToolInput): EgressDestinations {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return unknown("query is required.");
  const options = record(input.options);
  const include = domainList(options?.includeDomains);
  const exclude = domainList(options?.excludeDomains);
  if (!include || !exclude) return unknown("Search domain filters must be lists of domains.");
  const filters = [
    ...(include.length > 0 ? [`(${include.map((domain) => `site:${domain}`).join(" OR ")})`] : []),
    ...exclude.map((domain) => `-site:${domain}`),
  ];
  return known([{ kind: "search-query", query: [query, ...filters].join(" ") }]);
}

/**
 * The JSON body a provider-native send transmits: the explicit `body` object when present,
 * otherwise the named top-level fields (mirrors `bodyFromFields`).
 */
function sentBody(input: ToolInput, fields: readonly string[]): ToolInput | undefined {
  if ("body" in input) return record(input.body);
  return Object.fromEntries(fields.flatMap((key) => (key in input ? [[key, input[key]]] : [])));
}

/** A body key outside `allowed` may carry a destination no extractor reads. */
function unreadKey(body: ToolInput, allowed: ReadonlySet<string>, field: string) {
  const key = Object.keys(body).find((name) => !allowed.has(name));
  return key === undefined
    ? undefined
    : unknown(`${field}.${key} is not a field this boundary can read.`);
}

const SENDGRID_BODY_KEYS = new Set([
  "asm",
  "attachments",
  "batch_id",
  "categories",
  "content",
  "custom_args",
  "from",
  "ip_pool_name",
  "mail_settings",
  "personalizations",
  "reply_to",
  "reply_to_list",
  "send_at",
  "subject",
  "template_id",
  "tracking_settings",
]);
const SENDGRID_PERSONALIZATION_KEYS = new Set([
  "bcc",
  "cc",
  "custom_args",
  "dynamic_template_data",
  "from",
  "send_at",
  "subject",
  "substitutions",
  "to",
]);

/** `spam_check` is left out: its `post_to_url` sends the message to a URL no extractor reads. */
const SENDGRID_MAIL_SETTING_KEYS = new Set([
  "bcc",
  "bypass_bounce_management",
  "bypass_list_management",
  "bypass_spam_management",
  "bypass_unsubscribe_management",
  "footer",
  "sandbox_mode",
]);
/**
 * Tracking settings carry no destination: SendGrid rewrites links through its own tracking domain,
 * adds its own pixel and unsubscribe link, and appends UTM text. Any other key is unknown.
 */
const SENDGRID_TRACKING_SETTING_KEYS = new Set([
  "click_tracking",
  "ganalytics",
  "open_tracking",
  "subscription_tracking",
]);

function sendgridAddresses(value: unknown, field: string, required: boolean): EgressDestinations {
  if (value === undefined && !required) return known([]);
  if (!Array.isArray(value) || value.length === 0) {
    return unknown(`${field} must list at least one recipient.`);
  }
  return merge(
    ...value.map((entry, index) =>
      recipientAt(record(entry)?.email, `${field}[${index}].email`, EMAIL),
    ),
  );
}

function sendgridSend(input: ToolInput): EgressDestinations {
  const body = sentBody(input, ["personalizations", "from", "subject", "content", "template_id"]);
  if (!body) return unknown("body is not an object this boundary can read.");
  const unread = unreadKey(body, SENDGRID_BODY_KEYS, "body");
  if (unread) return unread;
  const personalizations = body.personalizations;
  if (!Array.isArray(personalizations) || personalizations.length === 0) {
    return unknown("body.personalizations must list at least one personalization.");
  }
  const mailSettings = body.mail_settings;
  if (mailSettings !== undefined && !record(mailSettings)) {
    return unknown("body.mail_settings is not an object this boundary can read.");
  }
  const trackingSettings = body.tracking_settings;
  if (trackingSettings !== undefined && !record(trackingSettings)) {
    return unknown("body.tracking_settings is not an object this boundary can read.");
  }
  const unreadSetting =
    unreadKey(record(mailSettings) ?? {}, SENDGRID_MAIL_SETTING_KEYS, "body.mail_settings") ??
    unreadKey(
      record(trackingSettings) ?? {},
      SENDGRID_TRACKING_SETTING_KEYS,
      "body.tracking_settings",
    );
  if (unreadSetting) return unreadSetting;
  const bccSetting = record(mailSettings)?.bcc;
  return merge(
    ...personalizations.map((entry, index) => {
      const field = `body.personalizations[${index}]`;
      const personalization = record(entry);
      if (!personalization) return unknown(`${field} is not an object this boundary can read.`);
      return (
        unreadKey(personalization, SENDGRID_PERSONALIZATION_KEYS, field) ??
        merge(
          sendgridAddresses(personalization.to, `${field}.to`, true),
          sendgridAddresses(personalization.cc, `${field}.cc`, false),
          sendgridAddresses(personalization.bcc, `${field}.bcc`, false),
        )
      );
    }),
    bccSetting === undefined
      ? known([])
      : recipientAt(record(bccSetting)?.email, "body.mail_settings.bcc.email", EMAIL),
  );
}

const POSTMARK_BODY_KEYS = new Set([
  "Attachments",
  "Bcc",
  "Cc",
  "From",
  "HtmlBody",
  "MessageStream",
  "Metadata",
  "ReplyTo",
  "Subject",
  "Tag",
  "TextBody",
  "To",
  "TrackLinks",
  "TrackOpens",
]);
/**
 * One `address`, `Name <address>`, or `"Name" <address>` entry. A quoted name holding a comma
 * splits into pieces that fail this, so the call is unknown.
 */
const POSTMARK_ENTRY = /^(?:(?:"[^"]*"\s*|[^<>,"]*)<([^<>\s]+)>|([^<>\s]+))$/u;

/** Postmark To, Cc, and Bcc are comma-separated address lists. */
function postmarkAddresses(value: unknown, field: string, required: boolean): EgressDestinations {
  if (value === undefined && !required) return known([]);
  if (typeof value !== "string" || !value.trim()) {
    return unknown(`${field} must list at least one recipient.`);
  }
  return merge(
    ...value.split(",").map((entry, index) => {
      const match = POSTMARK_ENTRY.exec(entry.trim());
      return recipientAt(match?.[1] ?? match?.[2], `${field}[${index}]`, EMAIL);
    }),
  );
}

function postmarkSend(input: ToolInput): EgressDestinations {
  const body = sentBody(input, ["From", "To", "Subject", "TextBody", "HtmlBody", "MessageStream"]);
  if (!body) return unknown("body is not an object this boundary can read.");
  return (
    unreadKey(body, POSTMARK_BODY_KEYS, "body") ??
    merge(
      postmarkAddresses(body.To, "body.To", true),
      postmarkAddresses(body.Cc, "body.Cc", false),
      postmarkAddresses(body.Bcc, "body.Bcc", false),
    )
  );
}

const DEMIO_BODY_KEYS = new Set(["date_id", "email", "event_id", "name"]);

function demioRegistration(input: ToolInput): EgressDestinations {
  const body = sentBody(input, ["event_id", "name", "email", "date_id"]);
  if (!body) return unknown("body is not an object this boundary can read.");
  return unreadKey(body, DEMIO_BODY_KEYS, "body") ?? recipientAt(body.email, "body.email", EMAIL);
}

const FIRECRAWL_SCRAPE_BODY_KEYS = new Set<string>([
  ...SELF_HOSTED_WEB_SCRAPE_OPTION_NAMES,
  "fastMode",
  "minAge",
  "url",
  "zeroDataRetention",
]);

/**
 * The page hosted Firecrawl scrapes: an explicit `body` is sent as written, with its `url`
 * replacing `url`.
 */
function firecrawlPageScrape(input: ToolInput): EgressDestinations {
  if (input.body === undefined) return firecrawlRequest(input, urlAt(input.url, "url"));
  const body = record(input.body);
  if (!body) return unknown("body is not an object this boundary can read.");
  return firecrawlRequest(
    input,
    unreadKey(body, FIRECRAWL_SCRAPE_BODY_KEYS, "body") ??
      (typeof body.url === "string" ? urlAt(body.url, "body.url") : urlAt(input.url, "url")),
  );
}

/**
 * A browser session navigates to `url`, then to every `navigate` action's `url`. Page scripts and
 * subresources reach origins the page chooses; the install-wide browser origin allowlist bounds
 * navigation, so only the navigated URLs are destinations.
 */
function browserSession(input: ToolInput): EgressDestinations {
  const actions = input.actions;
  if (!Array.isArray(actions)) return unknown("actions must be an array.");
  return merge(
    urlAt(input.url, "url"),
    ...actions.map((entry, index) => {
      const action = record(entry);
      if (typeof action?.type !== "string") {
        return unknown(`actions[${index}] is not an action this boundary can read.`);
      }
      return action.type === "navigate" ? urlAt(action.url, `actions[${index}].url`) : known([]);
    }),
  );
}

const browserTarget: Extractor = (input) => urlAt(input.url, "url");

const EXTRACTORS: Readonly<Record<string, Extractor>> = {
  "browser.capture_screenshot": browserTarget,
  "browser.dom_snapshot.capture": browserTarget,
  "browser.screenshot.capture": browserTarget,
  "browser.session.execute": browserSession,
  "browser.session.plan": browserTarget,
  "demio.event.registration.create": demioRegistration,
  "firecrawl.page.scrape": firecrawlPageScrape,
  "plivo.messages.send": (input) =>
    merge(recipientAt(input.dst, "dst", E164), optionalUrlAt(input.url, "url")),
  "postmark.email.send": postmarkSend,
  "sendgrid.email.send": sendgridSend,
  "twilio.messages.send": (input) =>
    merge(
      recipientAt(input.to, "to", E164),
      input.mediaUrls === undefined ? known([]) : urlsAt(input.mediaUrls, "mediaUrls"),
    ),
  "web.batch_scrape": (input) => firecrawlRequest(input, urlsAt(input.urls, "urls")),
  "web.crawl": (input) => firecrawlRequest(input, crawlTargets(input)),
  "web.map": (input) => firecrawlRequest(input, urlAt(input.url, "url")),
  "web.scrape": (input) => firecrawlRequest(input, urlAt(input.url, "url")),
  "web.search": (input) =>
    firecrawlRequest(input, merge(searchScrapesResults(input), searchQuery(input))),
};

/**
 * The registry is keyed by tool name, so it applies only to a public builtin whose executor is the
 * one that name selects; any other definition, such as hosted code, has no extractor.
 */
function perCallExtractor(definition: ToolAdapterDefinition): Extractor | undefined {
  const execution = definition.execution;
  if (
    toolEgress(definition) !== "public" ||
    execution?.type !== "builtin" ||
    execution.adapterKey !== definition.toolName ||
    !Object.hasOwn(EXTRACTORS, definition.toolName)
  ) {
    return undefined;
  }
  return EXTRACTORS[definition.toolName];
}

/** True when a public-egress tool's destinations can be read from each call's input. */
export function hasPerCallEgressDecision(definition: ToolAdapterDefinition): boolean {
  return perCallExtractor(definition) !== undefined;
}

/**
 * Where one call of a public-egress tool would send organization data, read from its input.
 * A tool without a per-call decision, or an input field this cannot read, is `unknown`.
 */
export function toolEgressDestinations(
  definition: ToolAdapterDefinition,
  input: ToolInput,
): EgressDestinations {
  const extractor = perCallExtractor(definition);
  if (extractor) return extractor(input);
  if (definition.execution?.type === "hosted_code" && toolEgress(definition) === "public") {
    return unknown(
      "Hosted code with network access can reach destinations its input does not name.",
    );
  }
  const reason = Object.hasOwn(ALWAYS_UNKNOWN_EGRESS_TOOLS, definition.toolName)
    ? ALWAYS_UNKNOWN_EGRESS_TOOLS[definition.toolName]
    : undefined;
  return unknown(reason ?? `No destination extractor is registered for ${definition.toolName}.`);
}
