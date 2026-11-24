import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  DEFAULT_FIRECRAWL_SCRAPE_TIMEOUT_MS,
  DEFAULT_FIRECRAWL_TIMEOUT_MS,
  FIRECRAWL_OPERATIONS,
  FIRECRAWL_SCRAPE_TIMEOUT_MARGIN_MS,
  MAX_FIRECRAWL_CRAWL_PAGES,
  MAX_FIRECRAWL_PARSE_FILE_BYTES,
  MAX_FIRECRAWL_RESPONSE_BYTES,
  SelfHostedWebToolError,
  configuredBaseUrl,
  nonEmpty,
  type FirecrawlFetch,
  type FirecrawlMethod,
  type FirecrawlOperation,
  type SelfHostedWebToolName,
  type SelfHostedWebToolParseArtifact,
  type SelfHostedWebToolsConfig,
  type SelfHostedWebToolsDependencies,
} from "./config.ts";
import {
  hasInteractiveActions,
  inputRecord,
  limitedDnsLookup,
  optionsFromInput,
  requestPayload,
  appendQuery,
  validateOperationInput,
  validateUrls,
} from "./input-validation.ts";
import {
  jobTicketConfig,
  protectJobResult,
  protectStartedJobResult,
  queryFromPaginationCursor,
  replaceUpstreamJobId,
  sanitizeFirecrawlResult,
  upstreamIdFromJobTicket,
} from "./job-tokens.ts";

/** The `code` of a Firecrawl failure body (`{ success: false, code, error }`), when it is a plain identifier. */
function firecrawlErrorCode(text: string) {
  try {
    const code = (JSON.parse(text) as { code?: unknown } | null)?.code;
    return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

async function boundedJson(response: Response, allowFailureEnvelope = false) {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (declaredLength > MAX_FIRECRAWL_RESPONSE_BYTES) {
    response.body?.cancel().catch(() => undefined);
    throw new SelfHostedWebToolError("Firecrawl response exceeded the maximum size.", 502);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_FIRECRAWL_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SelfHostedWebToolError("Firecrawl response exceeded the maximum size.", 502);
      }
      chunks.push(chunk.value);
    }
  }
  const text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString("utf8");
  if (!response.ok) {
    const code = firecrawlErrorCode(text);
    throw new SelfHostedWebToolError(
      `Firecrawl request failed with HTTP ${response.status}${code ? ` (${code})` : ""}.`,
      response.status,
      code,
    );
  }
  if (!text.trim()) return { success: true };
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new SelfHostedWebToolError("Firecrawl returned invalid JSON.", 502);
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).success === false &&
    !allowFailureEnvelope
  ) {
    throw new SelfHostedWebToolError("Firecrawl request failed.", 502);
  }
  return value;
}

/**
 * Gives a scrape Firecrawl's own deadline, inside the client's abort, so a slow page fails as a
 * Firecrawl SCRAPE_TIMEOUT the model can read instead of an aborted request. A model-set timeout
 * is clamped to that window. Firecrawl rejects a waitFor over half the timeout, so the default
 * grows to fit one.
 */
function withScrapeTimeout(payload: Record<string, unknown>, clientTimeoutMs: number) {
  const ceiling = Math.max(1_000, clientTimeoutMs - FIRECRAWL_SCRAPE_TIMEOUT_MARGIN_MS);
  const waitFor = typeof payload.waitFor === "number" ? payload.waitFor : 0;
  const requested =
    typeof payload.timeout === "number" && Number.isFinite(payload.timeout)
      ? payload.timeout
      : Math.max(DEFAULT_FIRECRAWL_SCRAPE_TIMEOUT_MS, waitFor * 2);
  return { ...payload, timeout: Math.round(Math.min(Math.max(requested, 1_000), ceiling)) };
}

async function firecrawlRequest(options: {
  readonly allowFailureEnvelope?: boolean;
  readonly config: SelfHostedWebToolsConfig;
  readonly fetchImpl: FirecrawlFetch;
  readonly input: Record<string, unknown>;
  readonly method: FirecrawlMethod;
  readonly path: string;
  readonly toolName: SelfHostedWebToolName;
  readonly version?: "v1" | "v2";
}) {
  const base = configuredBaseUrl(options.config);
  const prefix = base.pathname === "/" ? "" : base.pathname;
  base.pathname = `${prefix}/${options.version ?? "v2"}${options.path}`.replaceAll(/\/{2,}/gu, "/");
  const timeoutMs = Math.max(
    1_000,
    Math.min(options.config.timeoutMs ?? DEFAULT_FIRECRAWL_TIMEOUT_MS, 600_000),
  );
  const requested = requestPayload(options.toolName, options.input);
  const payload =
    options.toolName === "web.scrape" ? withScrapeTimeout(requested, timeoutMs) : requested;
  if (options.method === "GET") appendQuery(base, payload);
  const headers = new Headers({ accept: "application/json" });
  if (options.config.apiKey) headers.set("authorization", `Bearer ${options.config.apiKey}`);
  if (options.method !== "GET" && options.method !== "DELETE") {
    headers.set("content-type", "application/json");
  }
  const response = await options.fetchImpl(base, {
    ...(options.method !== "GET" && options.method !== "DELETE"
      ? { body: JSON.stringify(payload) }
      : {}),
    headers,
    method: options.method,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return boundedJson(response, options.allowFailureEnvelope);
}

function parseArtifactId(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new SelfHostedWebToolError("artifactId must be a non-empty string up to 512 characters.");
  }
  return value.trim();
}

function isPinnedVersionId(value: unknown) {
  return (
    typeof value === "string" && Boolean(value.trim()) && value.trim().toLowerCase() !== "null"
  );
}

const FIRECRAWL_PARSE_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".htm",
  ".html",
  ".odt",
  ".pdf",
  ".rtf",
  ".xls",
  ".xlsx",
  ".xhtml",
]);
const FIRECRAWL_PARSE_CONTENT_TYPES = new Set([
  "application/msword",
  "application/pdf",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/xhtml+xml",
  "text/html",
  "text/rtf",
]);

function supportedParseArtifact(fileName: string, contentType: string) {
  const extensionIndex = fileName.lastIndexOf(".");
  const extension = extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : "";
  const normalizedType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    FIRECRAWL_PARSE_EXTENSIONS.has(extension) || FIRECRAWL_PARSE_CONTENT_TYPES.has(normalizedType)
  );
}

function verifiedParseArtifact(options: {
  readonly artifactId: string;
  readonly loaded: SelfHostedWebToolParseArtifact;
  readonly scopeId: string;
}) {
  const { artifact, content } = options.loaded;
  const storage = artifact.data.storage;
  const fileName = storage.fileName;
  if (
    artifact.itemType !== "artifact" ||
    artifact.data.id !== options.artifactId ||
    artifact.data.organizationId !== options.scopeId ||
    artifact.data.status !== "available" ||
    artifact.data.visibility !== "organization" ||
    !isPinnedVersionId(storage.versionId)
  ) {
    throw new SelfHostedWebToolError(
      "Parse artifacts must be available, organization-scoped, and version pinned.",
    );
  }
  if (
    !(content instanceof Uint8Array) ||
    content.byteLength === 0 ||
    content.byteLength > MAX_FIRECRAWL_PARSE_FILE_BYTES ||
    storage.byteSize !== content.byteLength
  ) {
    throw new SelfHostedWebToolError(
      `Parse artifact bytes must match storage metadata and not exceed ${MAX_FIRECRAWL_PARSE_FILE_BYTES} bytes.`,
    );
  }
  if (storage.sha256 !== createHash("sha256").update(content).digest("hex")) {
    throw new SelfHostedWebToolError(
      "Parse artifact content hash does not match storage metadata.",
    );
  }
  if (
    typeof fileName !== "string" ||
    !fileName.trim() ||
    fileName.length > 255 ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw new SelfHostedWebToolError(
      "Parse artifact storage must include a safe filename up to 255 characters.",
    );
  }
  if (!/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/u.test(storage.contentType)) {
    throw new SelfHostedWebToolError("Parse artifact contentType must be a valid media type.");
  }
  if (!supportedParseArtifact(fileName, storage.contentType)) {
    throw new SelfHostedWebToolError("Parse artifact type is not supported by Firecrawl.");
  }
  return { content, contentType: storage.contentType, fileName };
}

async function firecrawlParseRequest(options: {
  readonly config: SelfHostedWebToolsConfig;
  readonly fetchImpl: FirecrawlFetch;
  readonly input: Record<string, unknown>;
  readonly loadParseArtifact: NonNullable<SelfHostedWebToolsDependencies["loadParseArtifact"]>;
}) {
  const scopeId = nonEmpty(options.config.scopeId);
  if (!scopeId) {
    throw new SelfHostedWebToolError("scopeId is required for Firecrawl parse artifacts.");
  }
  const artifactId = parseArtifactId(options.input.artifactId);
  const artifact = verifiedParseArtifact({
    artifactId,
    loaded: await options.loadParseArtifact({ artifactId, scopeId }),
    scopeId,
  });
  const form = new FormData();
  form.append(
    "file",
    new Blob([artifact.content], { type: artifact.contentType }),
    artifact.fileName,
  );
  form.append("options", JSON.stringify(optionsFromInput(options.input)));

  const base = configuredBaseUrl(options.config);
  const prefix = base.pathname === "/" ? "" : base.pathname;
  base.pathname = `${prefix}/v2/parse`.replaceAll(/\/{2,}/gu, "/");
  const headers = new Headers({ accept: "application/json" });
  if (options.config.apiKey) headers.set("authorization", `Bearer ${options.config.apiKey}`);
  const response = await options.fetchImpl(base, {
    body: form,
    headers,
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(
      Math.max(1_000, Math.min(options.config.timeoutMs ?? DEFAULT_FIRECRAWL_TIMEOUT_MS, 600_000)),
    ),
  });
  return boundedJson(response);
}

export async function executeSelfHostedWebTool(
  toolName: SelfHostedWebToolName,
  inputValue: unknown,
  config: SelfHostedWebToolsConfig,
  dependencies: SelfHostedWebToolsDependencies = {},
): Promise<unknown> {
  const operation: FirecrawlOperation | undefined = FIRECRAWL_OPERATIONS[toolName];
  if (!operation) throw new SelfHostedWebToolError(`Unsupported web tool ${toolName}.`);
  const input = inputRecord(toolName, inputValue);
  if (hasInteractiveActions(input)) {
    throw new SelfHostedWebToolError(
      "Interactive scrape actions require Firecrawl's hosted Fire Engine and are unavailable in the self-hosted runtime.",
    );
  }
  validateOperationInput(toolName, input);
  const boundedInput =
    toolName === "web.crawl" &&
    input.limit === undefined &&
    optionsFromInput(input).limit === undefined
      ? { ...input, limit: MAX_FIRECRAWL_CRAWL_PAGES }
      : input;
  const validated = (await validateUrls(boundedInput, {
    dnsLookup: limitedDnsLookup(dependencies.dnsLookup ?? lookup),
    hosts: new Map(),
  })) as Record<string, unknown>;
  const fetchImpl = dependencies.fetch ?? fetch;

  if (toolName === "web.parse") {
    if (!dependencies.loadParseArtifact) {
      throw new SelfHostedWebToolError("web.parse requires an artifact loader.");
    }
    return firecrawlParseRequest({
      config,
      fetchImpl,
      input: validated,
      loadParseArtifact: dependencies.loadParseArtifact,
    });
  }

  let requestInput = validated;
  let jobTicket: string | undefined;
  let upstreamJobId: string | undefined;
  if (operation.jobKind) {
    jobTicketConfig(config);
    if (!operation.startsJob) {
      jobTicket = typeof validated.id === "string" ? validated.id : undefined;
      upstreamJobId = upstreamIdFromJobTicket(validated.id, operation.jobKind, config);
      requestInput = { ...validated, id: upstreamJobId };
      if (operation.supportsCursor && validated.cursor !== undefined) {
        requestInput = {
          ...requestInput,
          ...queryFromPaginationCursor({
            config,
            cursor: validated.cursor,
            jobKind: operation.jobKind,
            upstreamId: upstreamJobId,
          }),
          cursor: undefined,
        };
      }
    }
  }

  const result = await firecrawlRequest({
    allowFailureEnvelope: toolName.endsWith("_status"),
    config,
    fetchImpl,
    input: requestInput,
    method: operation.method,
    path: operation.path(requestInput),
    toolName,
    ...(operation.version ? { version: operation.version } : {}),
  });
  if (operation.jobKind && operation.startsJob) {
    return protectStartedJobResult(result, operation.jobKind, config);
  }
  if (!jobTicket || !upstreamJobId || !operation.jobKind) {
    return sanitizeFirecrawlResult(result);
  }
  if (toolName.endsWith("_status")) {
    return protectJobResult({
      config,
      jobKind: operation.jobKind,
      ticket: jobTicket,
      upstreamId: upstreamJobId,
      value: result,
    });
  }
  return sanitizeFirecrawlResult(replaceUpstreamJobId(result, upstreamJobId, jobTicket));
}

export function makeSelfHostedWebToolExecutor(
  config: SelfHostedWebToolsConfig,
  dependencies: SelfHostedWebToolsDependencies = {},
) {
  return (toolName: SelfHostedWebToolName, input: unknown) =>
    executeSelfHostedWebTool(toolName, input, config, dependencies);
}
