import type { S3Client } from "@aws-sdk/client-s3";
import {
  BROWSER_SESSION_EXECUTE_TOOL_NAME,
  normalizeBrowserScreenshotInput,
  normalizeBrowserSessionExecuteInput,
  requirePublicBrowserScreenshotResolution,
  sandboxLoopbackOrigin,
  BrowserScreenshotInputError,
  type BrowserScreenshotConfig,
  type BrowserScreenshotDnsLookup,
  type BrowserScreenshotTargetPolicy,
  type BrowserSessionExecutionResult,
  type NormalizedBrowserScreenshotInput,
} from "@deployments-ai/browser-screenshot";
import { DEFAULT_LAMBDA_MICROVM_CONTROL_PORT } from "@deployments-ai/sandbox-hosts";
import {
  executePinnedHttpsWithSameOriginRedirects,
  NetSecurityError,
  NetSecurityRedirectError,
  readResponseTextWithByteLimit,
} from "@deployments-ai/net-security";
import {
  RuntimeToolPreparationRetryableError,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  workerPersistence,
} from "@deployments-ai/db";
import { isDeepStrictEqual } from "node:util";
import { lookup } from "node:dns/promises";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import {
  jsonToolResult,
  logicallyExpired,
  requiredString,
  toolInput,
  ulid,
} from "./builtin-tool-support.ts";
import {
  captureScreenshotInSandbox,
  checkedOrigins,
  executeBrowserSessionInSandbox,
  failedBrowserJobResult,
  isFailedBrowserJobResult,
  type BrowserSandboxOptions,
  type BrowserTargets,
} from "./browser-sandbox-job.ts";
import {
  createS3BrowserSessionEvidenceStore,
  type BrowserSessionEvidenceIdentity,
} from "./browser-session-evidence.ts";

export interface RuntimeBrowserToolOptions extends BrowserSandboxOptions {
  /** Artifact bucket holding `browser.session.execute` replay evidence. */
  readonly artifactBucket: string;
  readonly artifactKmsKeyId: string;
  readonly artifactS3: Pick<S3Client, "send">;
  readonly database: DynamoDatabaseService;
  readonly dnsLookup?: BrowserScreenshotDnsLookup;
  readonly loadScreenshotConfig: () => BrowserScreenshotConfig;
  readonly requestDomSnapshot?: typeof executePinnedHttpsWithSameOriginRedirects;
  /**
   * Guest port of the MicroVM control server; loopback captures may never target it. Defaults to
   * `DEFAULT_LAMBDA_MICROVM_CONTROL_PORT`.
   */
  readonly sandboxControlPort?: number;
}

type BrowserRequest = Parameters<ExecuteRuntimeBuiltinTool>[0];

const MAX_BROWSER_AUDIT_ARTIFACT_BYTES = 128 * 1024;
const MAX_BROWSER_DOM_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** Malformed input fails the run as a known failure; a refused target stays coded for the model. */
function invalidInput(cause: unknown): never {
  if (cause instanceof BrowserScreenshotInputError && cause.code === undefined) {
    throw new TypeError(cause.message, { cause });
  }
  throw cause;
}

/**
 * Returns a refused target (non-public host, origin off the allowlist, DNS failure or non-public
 * answer) as a failed tool result, like a job that failed in the browser, so the run continues and
 * the model can try another URL.
 */
async function withTargetRefusals(
  request: BrowserRequest,
  execute: () => Promise<RuntimeToolExecutionResult>,
) {
  try {
    return await execute();
  } catch (cause) {
    if (cause instanceof BrowserScreenshotInputError && cause.code !== undefined) {
      return failedBrowserJobResult(request.toolName, { code: cause.code, message: cause.message });
    }
    throw cause;
  }
}

function screenshotConfig(options: RuntimeBrowserToolOptions, toolName: string) {
  try {
    return options.loadScreenshotConfig();
  } catch (cause) {
    throw new RuntimeToolPreparationRetryableError(toolName, cause);
  }
}

/** The driver targets for a config, plus `extraOrigins` the caller already validated. */
function browserTargets(
  config: BrowserScreenshotConfig,
  extraOrigins: readonly string[] = [],
): BrowserTargets {
  return {
    allowedOrigins: new Set([
      ...(config.kind === "origins" ? config.allowedOrigins : []),
      ...extraOrigins,
    ]),
    anyPublicOrigin: config.kind === "any-public",
  };
}

function normalizedScreenshotTarget(
  input: Readonly<Record<string, unknown>>,
  allowedOrigins: ReadonlySet<string>,
  policy?: BrowserScreenshotTargetPolicy,
) {
  try {
    return normalizeBrowserScreenshotInput(input, allowedOrigins, policy);
  } catch (cause) {
    invalidInput(cause);
  }
}

/** Every navigated host must resolve exclusively to public addresses before the browser runs. */
async function requirePublicTargets(options: RuntimeBrowserToolOptions, urls: readonly string[]) {
  try {
    await Promise.all(
      urls.map((url) => requirePublicBrowserScreenshotResolution(url, options.dnsLookup ?? lookup)),
    );
  } catch (cause) {
    invalidInput(cause);
  }
}

function withoutSessionPlanId(input: Readonly<Record<string, unknown>>) {
  const { sessionPlanId: _sessionPlanId, ...rest } = input;
  return rest;
}

function planSource(record: PlatformRecord) {
  if (record.itemType !== "artifact") return undefined;
  const source = record.data.metadata?.source;
  return source && typeof source === "object" && !Array.isArray(source)
    ? (source as Readonly<Record<string, unknown>>)
    : undefined;
}

async function requireApprovedSessionPlan(
  options: RuntimeBrowserToolOptions,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  sessionPlanId: ReturnType<typeof ulid>,
  expectedTarget?:
    | { readonly kind: "exact"; readonly target: NormalizedBrowserScreenshotInput }
    | { readonly kind: "url"; readonly url: string },
) {
  let requestedPlanSeen = false;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  for (let pageIndex = 0; pageIndex < 40; pageIndex += 1) {
    let page;
    try {
      page = await workerPersistence.find(
        options.database,
        "execution",
        {
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
          ExpressionAttributeValues: {
            ":pk": key("ORG", request.organizationId, "RUN", request.runId, "ARTIFACTS"),
            ":sk": "ARTIFACT#",
          },
          IndexName: "gsi1",
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
          Limit: 250,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        },
        request.signal,
      );
    } catch (cause) {
      throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
    }
    for (const record of page.items) {
      const source = planSource(record);
      if (source?.kind === "browser-session-plan" && source.sessionPlanId === sessionPlanId) {
        requestedPlanSeen = true;
      }
      if (
        record.itemType === "artifact" &&
        record.data.organizationId === request.organizationId &&
        record.data.projectId === request.projectId &&
        record.data.environmentId === request.environmentId &&
        record.data.runId === request.runId &&
        record.data.agentDeploymentId === request.agentDeploymentId &&
        record.data.status === "available" &&
        record.data.visibility === "private" &&
        record.data.privateAccess === "runtime-only" &&
        !logicallyExpired(record.data.retentionExpiresAt) &&
        source?.kind === "browser-session-plan" &&
        source.runId === request.runId &&
        source.sessionPlanId === sessionPlanId &&
        (expectedTarget === undefined ||
          (expectedTarget.kind === "exact"
            ? isDeepStrictEqual(source.target, expectedTarget.target)
            : source.target !== null &&
              typeof source.target === "object" &&
              !Array.isArray(source.target) &&
              (source.target as Readonly<Record<string, unknown>>).url === expectedTarget.url))
      ) {
        return;
      }
    }
    exclusiveStartKey = page.lastEvaluatedKey;
    if (!exclusiveStartKey) break;
  }
  if (exclusiveStartKey) {
    throw new RuntimeToolPreparationRetryableError(
      request.toolName,
      new Error("Browser session plan lookup exceeded its bounded scan limit."),
    );
  }
  if (!requestedPlanSeen) {
    throw new RuntimeToolPreparationRetryableError(
      request.toolName,
      new Error("The approved browser session plan is not visible yet."),
    );
  }
  throw new TypeError("The approved browser session plan was not found for this run and target.");
}

function sessionToolResult(
  request: BrowserRequest,
  sessionPlanId: string,
  result: BrowserSessionExecutionResult,
): RuntimeToolExecutionResult {
  const publicTarget = new URL(result.finalUrl);
  publicTarget.search = "";
  publicTarget.hash = "";
  return {
    artifacts: [
      {
        content: result.dom,
        contentType: "text/html; charset=utf-8",
        fileName: `browser-session-${request.decision.toolCallId}.html`,
        label: "Browser session rendered DOM",
        metadata: {
          capturedAt: result.capturedAt,
          domTruncated: result.domTruncated,
          finalUrl: result.finalUrl,
          kind: "browser-session-dom",
          sessionPlanId,
        },
        type: "report",
        visibility: "private",
      },
      {
        content: result.screenshot,
        contentType: result.screenshotContentType,
        fileName: `browser-session-${request.decision.toolCallId}.png`,
        label: "Browser session screenshot",
        metadata: {
          capturedAt: result.capturedAt,
          finalUrl: result.finalUrl,
          kind: "browser-session-screenshot",
          sessionPlanId,
        },
        type: "screenshot",
        visibility: "private",
      },
    ],
    output: {
      actions: result.actions,
      capturedAt: result.capturedAt,
      domTruncated: result.domTruncated,
      finalUrl: result.finalUrl,
      title: result.title,
    },
    outputSummary: `Executed ${result.actions.length} browser action${result.actions.length === 1 ? "" : "s"} and captured rendered evidence for ${publicTarget.toString()}.`,
    status: "completed",
  };
}

export function createRuntimeBrowserBuiltinExecutors(
  options: RuntimeBrowserToolOptions,
): Readonly<Record<string, ExecuteRuntimeBuiltinTool>> {
  const sessionEvidence = createS3BrowserSessionEvidenceStore({
    bucket: options.artifactBucket,
    client: options.artifactS3,
    kmsKeyId: options.artifactKmsKeyId,
  });

  const captureScreenshot = async (
    request: BrowserRequest,
    target: NormalizedBrowserScreenshotInput,
    targets: BrowserTargets,
    policy: BrowserScreenshotTargetPolicy = {},
  ): Promise<RuntimeToolExecutionResult> => {
    // A sandbox loopback target never touches DNS; every other target must resolve publicly.
    if (!(typeof policy.sandboxLoopback === "object" && sandboxLoopbackOrigin(target.url))) {
      await requirePublicTargets(options, [target.url]);
    }
    const captured = await captureScreenshotInSandbox(options, request, target, targets, policy);
    if (captured.state === "failed") return failedBrowserJobResult(request.toolName, captured);
    const { artifact, outputSummary } = captured.value;
    return {
      artifacts: [
        {
          content: artifact.content,
          contentType: artifact.contentType,
          fileName: artifact.fileName,
          label: artifact.label,
          metadata: artifact.metadata,
          type: artifact.artifactType,
          visibility: "private",
        },
      ],
      outputSummary,
      status: "completed",
    };
  };

  const sessionRequest = (request: BrowserRequest) => {
    const input = toolInput(request.input ?? {});
    const sessionPlanId = ulid(input.sessionPlanId, "sessionPlanId");
    const targets = browserTargets(screenshotConfig(options, request.toolName));
    let normalized;
    try {
      normalized = normalizeBrowserSessionExecuteInput(
        withoutSessionPlanId(input),
        checkedOrigins(targets),
      );
    } catch (cause) {
      invalidInput(cause);
    }
    const identity: BrowserSessionEvidenceIdentity = {
      allowedOrigins: checkedOrigins(targets),
      idempotencyKey: request.idempotencyKey,
      input: normalized,
      runId: request.runId,
    };
    return { identity, sessionPlanId, targets };
  };

  const executeSession = (request: BrowserRequest) =>
    withTargetRefusals(request, () => runSession(request));

  const runSession = async (request: BrowserRequest): Promise<RuntimeToolExecutionResult> => {
    const { identity, sessionPlanId, targets } = sessionRequest(request);
    await requireApprovedSessionPlan(options, request, sessionPlanId, {
      kind: "url",
      url: identity.input.url,
    });
    await requirePublicTargets(options, [
      identity.input.url,
      ...identity.input.actions.flatMap((action) =>
        action.type === "navigate" ? [action.url] : [],
      ),
    ]);
    const executed = await executeBrowserSessionInSandbox(
      options,
      request,
      identity.input,
      targets,
    );
    if (executed.state === "failed") return failedBrowserJobResult(request.toolName, executed);
    const durable = await sessionEvidence.store(identity, executed.value, request.signal);
    return sessionToolResult(request, sessionPlanId, durable);
  };

  const sessionExecutor = Object.assign(executeSession, {
    mutationClaimResult: (result: RuntimeToolExecutionResult) =>
      isFailedBrowserJobResult(result)
        ? result
        : {
            artifacts: [],
            ...(result.outputSummary ? { outputSummary: result.outputSummary } : {}),
            status: result.status,
          },
    /**
     * Rebuilds the claimed result from stored evidence; the session never runs twice. A failed
     * session stored no evidence, and its claim keeps the failure itself.
     */
    refreshReplay: async (
      request: BrowserRequest,
      _definition: unknown,
      persisted: RuntimeToolExecutionResult,
    ) => {
      if (isFailedBrowserJobResult(persisted)) return persisted;
      let replayed;
      try {
        replayed = sessionRequest(request);
      } catch (cause) {
        // The session already ran; a target the current config refuses cannot change its result.
        if (cause instanceof BrowserScreenshotInputError) {
          throw new TypeError(cause.message, { cause });
        }
        throw cause;
      }
      const { identity, sessionPlanId } = replayed;
      const stored = await sessionEvidence.load(identity, request.signal);
      return sessionToolResult(request, sessionPlanId, stored);
    },
  }) satisfies ExecuteRuntimeBuiltinTool;

  return {
    "browser.capture_screenshot": (request) =>
      withTargetRefusals(request, async () => {
        const config = screenshotConfig(options, request.toolName);
        const input = toolInput(request.input ?? {});
        // Only the thread's persistent MicroVM outlives the call, so only there can the agent's own
        // dev server still be listening on loopback.
        const policy: BrowserScreenshotTargetPolicy = {
          sandboxLoopback:
            request.sandboxPolicy?.mode === "thread-persistent"
              ? { controlPort: options.sandboxControlPort ?? DEFAULT_LAMBDA_MICROVM_CONTROL_PORT }
              : "requires-thread-persistent",
        };
        const loopbackOrigin =
          typeof policy.sandboxLoopback === "object" && typeof input.url === "string"
            ? sandboxLoopbackOrigin(input.url)
            : undefined;
        const targets = browserTargets(config, loopbackOrigin ? [loopbackOrigin] : []);
        const target = normalizedScreenshotTarget(input, checkedOrigins(targets), policy);
        return captureScreenshot(request, target, targets, policy);
      }),
    "browser.screenshot.capture": (request) =>
      withTargetRefusals(request, async () => {
        const input = toolInput(request.input ?? {});
        const sessionPlanId = ulid(input.sessionPlanId, "sessionPlanId");
        const targets = browserTargets(screenshotConfig(options, request.toolName));
        const target = normalizedScreenshotTarget(
          withoutSessionPlanId(input),
          checkedOrigins(targets),
        );
        await requireApprovedSessionPlan(options, request, sessionPlanId, {
          kind: "exact",
          target,
        });
        return captureScreenshot(request, target, targets);
      }),
    "browser.session.plan": (request) =>
      withTargetRefusals(request, async () => {
        const input = toolInput(request.input ?? {});
        const loadedScreenshotConfig = screenshotConfig(options, request.toolName);
        const normalized = normalizedScreenshotTarget(
          input,
          checkedOrigins(browserTargets(loadedScreenshotConfig)),
        );
        const plan = {
          ...(loadedScreenshotConfig.kind === "origins"
            ? { allowedOrigins: loadedScreenshotConfig.allowedOrigins }
            : { anyPublicOrigin: true }),
          createdForRunId: request.runId,
          sessionPlanId: request.decision.toolCallId,
          target: normalized,
        };
        return jsonToolResult({
          fileName: `browser-session-plan-${request.decision.toolCallId}.json`,
          label: "Browser session plan",
          metadata: {
            kind: "browser-session-plan",
            runId: request.runId,
            sessionPlanId: request.decision.toolCallId,
            target: normalized,
          },
          summary: `Prepared browser session plan ${request.decision.toolCallId} for ${new URL(normalized.url).origin}.`,
          value: plan,
          visibility: "private",
        });
      }),
    "browser.dom_snapshot.capture": (request) =>
      withTargetRefusals(request, async () => {
        const input = toolInput(request.input ?? {});
        const url = requiredString(input, "url", 8_192);
        const sessionPlanId = ulid(input.sessionPlanId, "sessionPlanId");
        const loadedScreenshotConfig = screenshotConfig(options, request.toolName);
        const target = normalizedScreenshotTarget(
          { url },
          checkedOrigins(browserTargets(loadedScreenshotConfig)),
        );
        await requireApprovedSessionPlan(options, request, sessionPlanId, {
          kind: "url",
          url: target.url,
        });
        let snapshot;
        try {
          snapshot = await (
            options.requestDomSnapshot ?? executePinnedHttpsWithSameOriginRedirects
          )({
            signal: request.signal
              ? AbortSignal.any([request.signal, AbortSignal.timeout(target.timeoutMs)])
              : AbortSignal.timeout(target.timeoutMs),
            url: target.url,
            verifiedOrigin: new URL(target.url).origin,
          });
        } catch (cause) {
          if (
            cause instanceof NetSecurityRedirectError ||
            (cause instanceof NetSecurityError && cause.code !== "empty-dns")
          ) {
            throw new TypeError("The DOM snapshot target or redirect was not allowed.", { cause });
          }
          throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
        }
        if (!snapshot.response.ok) {
          await snapshot.response.body?.cancel().catch(() => undefined);
          const status = snapshot.response.status;
          if (status === 408 || status === 425 || status === 429 || status >= 500) {
            throw new RuntimeToolPreparationRetryableError(
              request.toolName,
              new Error(`DOM snapshot target returned HTTP ${status}.`),
            );
          }
          throw new TypeError(`DOM snapshot target returned HTTP ${status}.`);
        }
        const contentType =
          snapshot.response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ??
          "";
        if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
          await snapshot.response.body?.cancel().catch(() => undefined);
          throw new TypeError("DOM snapshot target did not return HTML.");
        }
        let html: string;
        try {
          html = await readResponseTextWithByteLimit(
            snapshot.response,
            MAX_BROWSER_DOM_SNAPSHOT_BYTES,
            "DOM snapshot response",
          );
        } catch (cause) {
          if (cause instanceof Error && cause.message === "DOM snapshot response was too large.") {
            throw new TypeError(cause.message, { cause });
          }
          throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
        }
        return jsonToolResult({
          fileName: `browser-dom-snapshot-${request.decision.toolCallId}.json`,
          label: "Browser DOM snapshot",
          summary: `Captured DOM evidence for ${new URL(snapshot.finalUrl).origin}.`,
          value: {
            contentType,
            finalUrl: snapshot.finalUrl,
            html,
            status: snapshot.response.status,
          },
        });
      }),
    "browser.session.audit_report": async (request) => {
      const input = toolInput(request.input ?? {});
      const sessionPlanId = ulid(input.sessionPlanId, "sessionPlanId");
      await requireApprovedSessionPlan(options, request, sessionPlanId);
      const value = {
        audit: input,
        recordedForRunId: request.runId,
        sessionPlanId,
        toolCallId: request.decision.toolCallId,
      };
      if (
        new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`).byteLength >
        MAX_BROWSER_AUDIT_ARTIFACT_BYTES
      ) {
        throw new TypeError("The browser session audit report is too large.");
      }
      return jsonToolResult({
        fileName: `browser-session-audit-${request.decision.toolCallId}.json`,
        label: "Browser session audit report",
        metadata: {
          kind: "browser-session-audit",
          runId: request.runId,
          sessionPlanId,
        },
        summary: "Recorded a browser session audit report.",
        value,
      });
    },
    [BROWSER_SESSION_EXECUTE_TOOL_NAME]: sessionExecutor,
  };
}
