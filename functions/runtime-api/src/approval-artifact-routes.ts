import { resolveRunApproval, resolveRunToolResult } from "@deployments-ai/worker/approvals";
import { key } from "@deployments-ai/db";
import {
  completeArtifactUpload,
  createArtifactAccessUrl,
  createArtifactUpload,
  deleteArtifact,
  getArtifact,
  listArtifacts,
  updateArtifactRetention,
} from "./artifact-operations.ts";
import {
  publicApproval,
  publicCallbackDispatchEvidence,
  publicRun,
  publicToolCall,
} from "./public-projections.ts";
import {
  optionalExternalOperationId,
  toolResultOutput,
  stringValue,
} from "./request-validation.ts";
import type { RuntimeRouteContext } from "./runtime-handler.ts";
import { getApproval, listApprovals, listRunToolCalls } from "./runtime-operations.ts";
import type { HttpApiResult } from "./runtime-support.ts";
import {
  RuntimeApiError,
  assertRecord,
  appendRuntimeThreadEvent,
  getRecord,
  id,
  requireScope,
  response,
  scoped,
} from "./runtime-support.ts";

export async function handleApprovalArtifactRoutes(
  context: RuntimeRouteContext,
): Promise<HttpApiResult | undefined> {
  const { body, dependencies, event, method, path, principal } = context;
  let match: RegExpExecArray | null;

  if (method === "GET" && (match = /^\/v1\/callback-dispatch-evidence\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "approvals:read");
    const evidenceId = id(match[1], "evidenceId");
    const evidence = scoped(
      assertRecord(
        await getRecord(dependencies.database, "execution", {
          pk: key("ORG", principal.scope.organizationId, "CALLBACK-DISPATCH-EVIDENCE"),
          sk: key("CALLBACK-DISPATCH-EVIDENCE", evidenceId),
        }),
        "callback-dispatch-evidence",
        "Callback dispatch evidence",
      ),
      principal,
    );
    return response(200, publicCallbackDispatchEvidence(evidence));
  }

  if (method === "GET" && path === "/v1/approvals") {
    requireScope(principal, "approvals:read");
    return response(
      200,
      await listApprovals(dependencies, principal, event.queryStringParameters ?? {}),
    );
  }
  if (method === "GET" && (match = /^\/v1\/runs\/([^/]+)\/approvals\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "approvals:read");
    return response(
      200,
      await getApproval(dependencies, principal, id(match[1], "runId"), id(match[2], "approvalId")),
    );
  }
  if (method === "GET" && (match = /^\/v1\/runs\/([^/]+)\/tool-calls$/u.exec(path))) {
    requireScope(principal, "runs:read");
    return response(
      200,
      await listRunToolCalls(
        dependencies,
        principal,
        id(match[1], "runId"),
        event.queryStringParameters ?? {},
      ),
    );
  }
  if (
    method === "POST" &&
    (match = /^\/v1\/runs\/([^/]+)\/approvals\/([^/]+)\/resolve$/u.exec(path))
  ) {
    requireScope(principal, "approvals:write");
    const decision = stringValue(body, "decision");
    if (decision !== "approved" && decision !== "rejected") {
      throw new RuntimeApiError(400, "invalid_request", "decision must be approved or rejected.");
    }
    const result = await resolveRunApproval(
      {
        ...principal.scope,
        approvalId: id(match[2], "approvalId"),
        decision,
        // People are attributed by principal; API-key resolutions stay service attributed.
        ...(principal.kind === "human" ? { resolvedByPrincipalId: principal.principalId } : {}),
        runId: id(match[1], "runId"),
        threadId: id(stringValue(body, "threadId"), "threadId"),
      },
      {
        appendThreadEvent: (event) => appendRuntimeThreadEvent(dependencies, event),
        database: dependencies.database,
        enqueueRun: dependencies.enqueueRun,
        enqueueTerminalRun: dependencies.enqueueRun,
        generateId: dependencies.generateId,
        ...(dependencies.now ? { now: dependencies.now } : {}),
      },
    );
    return response(200, {
      approval: publicApproval(result.approval),
      decision: result.decision,
      run: publicRun(result.run),
      toolCall: publicToolCall(result.toolCall),
    });
  }
  if (
    method === "POST" &&
    (match = /^\/v1\/runs\/([^/]+)\/tool-calls\/([^/]+)\/results$/u.exec(path))
  ) {
    requireScope(principal, "runs:write");
    const outcome = stringValue(body, "outcome");
    if (outcome !== "completed" && outcome !== "failed")
      throw new RuntimeApiError(400, "invalid_request", "outcome must be completed or failed.");
    const outputSummary = stringValue(body, "outputSummary", false);
    const externalOperationId = optionalExternalOperationId(body);
    const output = toolResultOutput(body);
    const result = await resolveRunToolResult(
      {
        ...principal.scope,
        ...(externalOperationId ? { externalOperationId } : {}),
        outcome,
        ...(output ? { output } : {}),
        ...(outputSummary ? { outputSummary } : {}),
        runId: id(match[1], "runId"),
        threadId: id(stringValue(body, "threadId"), "threadId"),
        toolCallId: id(match[2], "toolCallId"),
      },
      {
        appendThreadEvent: (event) => appendRuntimeThreadEvent(dependencies, event),
        database: dependencies.database,
        enqueueRun: dependencies.enqueueRun,
        enqueueTerminalRun: dependencies.enqueueRun,
        generateId: dependencies.generateId,
        ...(dependencies.now ? { now: dependencies.now } : {}),
      },
    );
    return response(200, {
      outcome: result.outcome,
      run: publicRun(result.run),
      toolCall: publicToolCall(result.toolCall),
    });
  }
  if (method === "GET" && path === "/v1/artifacts") {
    requireScope(principal, "artifacts:read");
    return response(
      200,
      await listArtifacts(dependencies, principal, event.queryStringParameters ?? {}),
    );
  }
  if (method === "POST" && path === "/v1/artifacts") {
    requireScope(principal, "artifacts:write");
    return response(201, await createArtifactUpload(dependencies, principal, body));
  }
  if (method === "GET" && (match = /^\/v1\/artifacts\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "artifacts:read");
    return response(200, await getArtifact(dependencies, principal, id(match[1], "artifactId")));
  }
  if (method === "DELETE" && (match = /^\/v1\/artifacts\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "artifacts:write");
    return response(200, await deleteArtifact(dependencies, principal, id(match[1], "artifactId")));
  }
  if (method === "POST" && (match = /^\/v1\/artifacts\/([^/]+)\/access-urls$/u.exec(path))) {
    requireScope(principal, "artifacts:read");
    return response(
      201,
      await createArtifactAccessUrl(dependencies, principal, id(match[1], "artifactId"), body),
    );
  }
  if (method === "POST" && (match = /^\/v1\/artifacts\/([^/]+)\/complete$/u.exec(path))) {
    requireScope(principal, "artifacts:write");
    return response(
      200,
      await completeArtifactUpload(dependencies, principal, id(match[1], "artifactId")),
    );
  }
  if (method === "PATCH" && (match = /^\/v1\/artifacts\/([^/]+)\/retention$/u.exec(path))) {
    requireScope(principal, "artifacts:write");
    return response(
      200,
      await updateArtifactRetention(dependencies, principal, id(match[1], "artifactId"), body),
    );
  }
  return undefined;
}
