import {
  createConversationMessagePublicationService,
  createConversationStreamSession,
  conversationHistorySnapshot,
  parseEndUserId,
  readConversationHistory,
} from "@deployments-ai/conversations";
import { key } from "@deployments-ai/db";
import { signThreadStreamSessionToken } from "@deployments-ai/streaming";
import { enqueueExternalPublicationSettledRecovery } from "@deployments-ai/worker/publication-recovery";
import { publicMessagePublication, publicRun, publicThread } from "./public-projections.ts";
import { loadFinalizedRunMessage, loadRun } from "./run-message-read.ts";
import { listRunsMatching, runListQuery } from "./run-listing.ts";
import {
  agentRunSubmissionRequest,
  runMessagePublicationRequest,
  runSearchRequest,
  runtimeListCursor,
  threadCreationRequest,
} from "./request-validation.ts";
import type { RuntimeRouteContext } from "./runtime-handler.ts";
import { recordActor, runInitiatingCaller } from "./runtime-principal.ts";
import {
  cancelRunThreadEvents,
  publishRunMutationThreadEvents,
  runMutationThreadEvents,
} from "./runtime-handler.ts";
import {
  archiveThread,
  cancelRun,
  createThread,
  listThreads,
  loadRunById,
  replayRun,
  retryRun,
} from "./runtime-operations.ts";
import type { HttpApiResult } from "./runtime-support.ts";
import {
  appendRuntimeThreadEvent,
  assertRecord,
  conversationService,
  getRecord,
  id,
  loadThread,
  publicMessage,
  publicMessagePage,
  publicRecord,
  requiredIdempotencyKey,
  requireScope,
  response,
  RuntimeApiError,
  scoped,
  signThreadHistoryCursor,
  verifyThreadHistoryCursor,
} from "./runtime-support.ts";
import { streamSessionForReturnedHistory } from "./stream-session-history.ts";
import { threadStreamUrl } from "./stream-gateway-url.ts";

export async function handleRunThreadRoutes(
  context: RuntimeRouteContext,
): Promise<HttpApiResult | undefined> {
  const { body, dependencies, event, method, path, principal } = context;
  let match: RegExpExecArray | null;

  if (method === "GET" && path === "/v1/runs") {
    requireScope(principal, "runs:read");
    const parameters = event.queryStringParameters ?? {};
    return response(
      200,
      await listRunsMatching(dependencies, principal, parameters, runListQuery(parameters)),
    );
  }
  if (method === "POST" && path === "/v1/runs/search") {
    requireScope(principal, "runs:read");
    const { cursor, limit, ...query } = runSearchRequest(body);
    return response(
      200,
      await listRunsMatching(
        dependencies,
        principal,
        { cursor, ...(limit !== undefined ? { limit: String(limit) } : {}) },
        query,
      ),
    );
  }
  if (method === "GET" && (match = /^\/v1\/runs\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "runs:read");
    return response(
      200,
      publicRun(await loadRunById(dependencies, principal, id(match[1], "runId"))),
    );
  }
  if (method === "POST" && (match = /^\/v1\/runs\/([^/]+)\/(cancel|retry|replay)$/u.exec(path))) {
    requireScope(principal, "runs:write");
    const runId = id(match[1], "runId");
    const operation = match[2];
    if (operation === "cancel") {
      const result = await cancelRun(dependencies, principal, runId);
      for (const threadEvent of cancelRunThreadEvents(principal, result)) {
        await appendRuntimeThreadEvent(dependencies, threadEvent);
      }
      return response(200, result.run);
    }
    if (operation !== "retry" && operation !== "replay") {
      throw new RuntimeApiError(404, "not_found", "Runtime API route was not found.");
    }
    const result =
      operation === "retry"
        ? await retryRun(dependencies, principal, runId)
        : await replayRun(dependencies, principal, runId, requiredIdempotencyKey(event));
    if (result.publication) {
      await publishRunMutationThreadEvents(
        operation,
        runMutationThreadEvents(operation, principal, result.snapshot),
        (threadEvent) => appendRuntimeThreadEvent(dependencies, threadEvent),
      );
    }
    return response(202, result.run);
  }
  if (method === "POST" && (match = /^\/v1\/agent-deployments\/([^/]+)\/runs$/u.exec(path))) {
    requireScope(principal, "runs:write");
    const deploymentId = id(match[1], "agentDeploymentId");
    scoped(
      assertRecord(
        await getRecord(dependencies.database, "control", {
          pk: key("ORG", principal.scope.organizationId, "ENV", principal.scope.environmentId),
          sk: key("AGENT-DEPLOYMENT", deploymentId),
        }),
        "agent-deployment",
        "Agent deployment",
      ),
      principal,
    );
    const idempotencyKey = requiredIdempotencyKey(event);
    const input = agentRunSubmissionRequest(body);
    const {
      endUserId,
      inputArtifacts,
      rebaseRelease,
      responseFormat,
      responsePublication,
      runContext,
      threadId,
      title,
      workspaceId,
    } = input;
    if (inputArtifacts) requireScope(principal, "artifacts:read");
    const requestedWorkspaceId = workspaceId ? id(workspaceId, "workspaceId") : undefined;
    const result = await conversationService(dependencies).submitTurn({
      ...principal.scope,
      actor: recordActor(principal),
      agentDeploymentId: deploymentId,
      content: input.content,
      ...(endUserId !== undefined
        ? {
            endUserKey: dependencies.endUserSubjects(
              principal.scope.organizationId,
              parseEndUserId(endUserId, "thread"),
            ),
          }
        : {}),
      idempotencyKey,
      initiatingCaller: runInitiatingCaller(principal),
      ...(inputArtifacts ? { inputArtifacts } : {}),
      ...(responseFormat ? { responseFormat } : {}),
      ...(responsePublication ? { responsePublication } : {}),
      ...(runContext !== undefined ? { runContext } : {}),
      ...(rebaseRelease ? { rebaseRelease } : {}),
      ...(threadId ? { threadId: id(threadId, "threadId") } : {}),
      ...(title ? { title } : {}),
      ...(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}),
    });
    return response(202, {
      created: result.created,
      message: publicRecord(result.message),
      run: publicRun(result.run),
      thread: publicThread(result.thread),
    });
  }
  if (method === "GET" && path === "/v1/threads") {
    requireScope(principal, "runs:read");
    const executionBindingId = event.queryStringParameters?.executionBindingId;
    return response(
      200,
      await listThreads(
        dependencies,
        principal,
        event.queryStringParameters ?? {},
        executionBindingId === undefined ? undefined : id(executionBindingId, "executionBindingId"),
      ),
    );
  }
  if (method === "POST" && path === "/v1/threads") {
    requireScope(principal, "runs:write");
    const input = threadCreationRequest(body);
    return response(
      201,
      await createThread(dependencies, principal, {
        agentDeploymentId: id(input.agentDeploymentId, "agentDeploymentId"),
        ...(input.channel ? { channel: input.channel } : {}),
        ...(input.continueFromThreadId
          ? { continueFromThreadId: id(input.continueFromThreadId, "continueFromThreadId") }
          : {}),
        ...(input.endUserId !== undefined
          ? {
              endUserKey: dependencies.endUserSubjects(
                principal.scope.organizationId,
                parseEndUserId(input.endUserId, "thread"),
              ),
            }
          : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.workspaceId ? { workspaceId: id(input.workspaceId, "workspaceId") } : {}),
      }),
    );
  }
  if (method === "POST" && (match = /^\/v1\/threads\/([^/]+)\/archive$/u.exec(path))) {
    requireScope(principal, "runs:write");
    return response(200, await archiveThread(dependencies, principal, id(match[1], "threadId")));
  }
  if (method === "GET" && (match = /^\/v1\/threads\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "runs:read");
    return response(
      200,
      publicThread(await loadThread(dependencies, principal, id(match[1], "threadId"))),
    );
  }
  if (method === "GET" && (match = /^\/v1\/threads\/([^/]+)\/messages$/u.exec(path))) {
    requireScope(principal, "runs:read");
    const threadId = id(match[1], "threadId");
    await loadThread(dependencies, principal, threadId);
    const cursorToken =
      event.queryStringParameters?.cursor !== undefined
        ? runtimeListCursor(event.queryStringParameters.cursor)
        : undefined;
    const cursor = cursorToken
      ? verifyThreadHistoryCursor(
          cursorToken,
          { ...principal.scope, threadId },
          dependencies.sessionTokenSecret,
        )
      : undefined;
    if (cursorToken && !cursor) {
      throw new RuntimeApiError(400, "invalid_cursor", "Conversation cursor is invalid.");
    }
    const snapshot = cursor
      ? undefined
      : await conversationHistorySnapshot(dependencies.database, {
          ...principal.scope,
          threadId,
        });
    const history = await readConversationHistory(
      dependencies.database,
      { ...principal.scope, threadId },
      {
        ...(cursor ? { cursor } : {}),
        ...(event.queryStringParameters?.limit
          ? { limit: Number(event.queryStringParameters.limit) }
          : {}),
        ...(snapshot ? { upperSk: snapshot.upperSk } : {}),
      },
    );
    const page = await publicMessagePage(
      history.items,
      dependencies,
      history.nextCursor,
      history.snapshotUpperSk,
    );
    return response(
      200,
      page.nextCursor
        ? {
            ...page,
            nextCursor: signThreadHistoryCursor(
              page.nextCursor,
              { ...principal.scope, threadId },
              dependencies.sessionTokenSecret,
            ),
          }
        : page,
    );
  }
  if (method === "POST" && (match = /^\/v1\/threads\/([^/]+)\/stream-sessions$/u.exec(path))) {
    requireScope(principal, "runs:read");
    const threadId = id(match[1], "threadId");
    const streamUrl = threadStreamUrl(dependencies.streamGatewayBaseUrl, threadId);
    await loadThread(dependencies, principal, threadId);
    const now = dependencies.now?.() ?? new Date();
    const claims = {
      ...principal.scope,
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      permissions: ["read"] as const,
      sessionId: await dependencies.generateId(),
      threadId,
    };
    const session = await createConversationStreamSession({
      claims,
      createReadUrl: (offset) => `${streamUrl}?offset=${encodeURIComponent(offset)}`,
      database: dependencies.database,
      scope: claims,
      transport: dependencies.durableTransport,
    });
    const publicHistory = await publicMessagePage(
      session.history.items,
      dependencies,
      session.history.nextCursor,
      session.history.snapshotUpperSk,
    );
    const returnedHistory = session.history.items.slice(0, publicHistory.messages.length);
    return response(201, {
      accessToken: signThreadStreamSessionToken(claims, {
        secret: dependencies.sessionTokenSecret,
      }),
      history: publicHistory.messages,
      ...(publicHistory.nextCursor
        ? {
            historyNextCursor: signThreadHistoryCursor(
              publicHistory.nextCursor,
              { ...principal.scope, threadId },
              dependencies.sessionTokenSecret,
            ),
          }
        : {}),
      session: streamSessionForReturnedHistory(session.session, returnedHistory),
      streamUrl,
    });
  }
  if (method === "GET" && (match = /^\/v1\/threads\/([^/]+)\/runs\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "runs:read");
    return response(
      200,
      publicRun(
        await loadRun(dependencies, principal, id(match[1], "threadId"), id(match[2], "runId")),
      ),
    );
  }
  if (
    method === "GET" &&
    (match = /^\/v1\/threads\/([^/]+)\/runs\/([^/]+)\/message$/u.exec(path))
  ) {
    requireScope(principal, "runs:read");
    const run = await loadRun(
      dependencies,
      principal,
      id(match[1], "threadId"),
      id(match[2], "runId"),
    );
    return response(
      200,
      await publicMessage(
        await loadFinalizedRunMessage(dependencies, principal, run),
        dependencies,
      ),
    );
  }
  if (
    method === "POST" &&
    (match =
      /^\/v1\/threads\/([^/]+)\/runs\/([^/]+)\/message\/(publication-reservations|publication-releases|publications)$/u.exec(
        path,
      ))
  ) {
    requireScope(principal, "runs:write");
    const threadId = id(match[1], "threadId");
    const runId = id(match[2], "runId");
    const [thread, run] = await Promise.all([
      loadThread(dependencies, principal, threadId),
      loadRun(dependencies, principal, threadId, runId),
    ]);
    const sourceMessage = await loadFinalizedRunMessage(dependencies, principal, run);
    const input = runMessagePublicationRequest(body);
    const service = createConversationMessagePublicationService({
      appendThreadEvent: (threadEvent, signal) =>
        appendRuntimeThreadEvent(dependencies, threadEvent, signal),
      database: dependencies.database,
      generateId: dependencies.generateId,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    });
    const publicationInput = {
      actor: recordActor(principal),
      idempotencyKey: requiredIdempotencyKey(event),
      content: input.content,
      run,
      sourceMessage,
      thread,
    };
    if (match[3] === "publication-reservations") {
      const reservation = await service.reserve(publicationInput);
      // Reservation creation is not evidence that a non-idempotent provider send began. The
      // delivery adapter must durably fence dispatch separately and reconcile abandoned sends.
      return response(200, publicMessagePublication(reservation.publication));
    }
    if (match[3] === "publication-releases") {
      const release = await service.release(publicationInput);
      await enqueueExternalPublicationSettledRecovery(
        dependencies.enqueueRun,
        run,
        release.publication,
      );
      return response(200, publicMessagePublication(release.publication));
    }
    const publication = await service.publish(publicationInput);
    await enqueueExternalPublicationSettledRecovery(
      dependencies.enqueueRun,
      run,
      publication.publication,
    );
    return response(200, await publicMessage(publication.message, dependencies));
  }
  return undefined;
}
