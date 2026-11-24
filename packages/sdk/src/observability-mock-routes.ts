import type { PlatformRequest } from "./index.ts";

/** Tenant identifiers a mock response reports when the request carries no scope context. */
export function mockRequestTenant(request: PlatformRequest) {
  return {
    environmentId: request.context?.environmentId ?? "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    organizationId: request.context?.organizationId ?? "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    projectId: request.context?.projectId ?? "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  };
}

/** Deterministic observability, usage, spend, and audit-event responses for the mock transport. */
export function mockObservabilityData(
  request: PlatformRequest,
  now: string,
): { readonly matched: false } | { readonly matched: true; readonly data: unknown } {
  const path = request.path;
  const { environmentId, organizationId, projectId } = mockRequestTenant(request);
  const observabilityTrace = {
    agent_deployment_id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
    agent_release_id: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    completed_at: now,
    duration_ms: 1_200,
    environment_id: environmentId,
    execution_purpose: "customer",
    fact_id: "fact_mock_trace",
    finalized_at: now,
    occurred_at: now,
    project_id: projectId,
    root_run_id: "run_mock_root",
    run_count: 1,
    run_id: "run_mock_root",
    session_id: "session_mock",
    status: "ok",
    total_cost_usd_micros: 7,
    total_tokens: 12,
    trace_id: "0123456789abcdef0123456789abcdef",
  } as const;
  if (
    path === "/v1/observability/traces" ||
    /^\/v1\/observability\/sessions\/[^/]+\/traces$/u.test(path)
  ) {
    return { matched: true, data: { items: [observabilityTrace] } };
  }
  if (/^\/v1\/observability\/traces\/[^/]+\/spans$/u.test(path)) {
    return {
      matched: true,
      data: {
        items: [
          {
            actual_model_id: "mock-actual-model",
            actual_provider: "mock-provider",
            duration_ms: 42,
            fact_id: "fact_mock_span",
            kind: "run",
            name: "agent.run",
            occurred_at: now,
            requested_model_id: "mock-requested-model",
            requested_provider: "mock-provider",
            run_id: "run_mock_root",
            session_id: "session_mock",
            span_id: "0123456789abcdef",
            status: "ok",
            total_tokens: 12,
            trace_id: decodeURIComponent(path.split("/")[4] ?? observabilityTrace.trace_id),
          },
        ],
      },
    };
  }
  if (/^\/v1\/observability\/traces\/[^/]+$/u.test(path)) {
    return {
      matched: true,
      data: {
        ...observabilityTrace,
        trace_id: decodeURIComponent(path.split("/")[4] ?? observabilityTrace.trace_id),
      },
    };
  }
  if (/^\/v1\/observability\/runs\/[^/]+\/trace$/u.test(path)) {
    return {
      matched: true,
      data: {
        ...observabilityTrace,
        root_run_id: decodeURIComponent(path.split("/")[4] ?? observabilityTrace.root_run_id),
        run_id: decodeURIComponent(path.split("/")[4] ?? observabilityTrace.run_id),
      },
    };
  }
  if (path === "/v1/observability/metrics") {
    const from = new Date(Date.parse(now) - 86_400_000).toISOString();
    return {
      matched: true,
      data: {
        from,
        interval: "hour",
        items: [
          {
            bucket: now,
            error_count: 0,
            p50_duration_ms: 1_200,
            p95_duration_ms: 1_200,
            total_cost_usd_micros: 7,
            total_tokens: 12,
            trace_count: 1,
          },
        ],
        source: "traces",
        to: now,
      },
    };
  }
  if (path === "/v1/observability/tools") {
    return {
      matched: true,
      data: {
        from: new Date(Date.parse(now) - 86_400_000).toISOString(),
        items: [{ calls: 1, errors: 0, name: "mock.tool", p95_duration_ms: 42 }],
        to: now,
      },
    };
  }
  if (path === "/v1/observability/exports") {
    return { matched: true, data: { generatedAt: now, items: [observabilityTrace] } };
  }
  if (path === "/v1/usage/summary" || path === "/v1/costs/summary") {
    // One hourly bucket at the start of `now`'s hour, holding the list fixtures below.
    const since = `${now.slice(0, 13)}:00:00.000Z`;
    const until = new Date(Date.parse(since) + 3_600_000).toISOString();
    const series =
      path === "/v1/usage/summary"
        ? { kind: "quantity", metric: "model.tokens", total: 12, unit: "tokens", values: [12] }
        : {
            kind: "cost",
            metric: "model",
            total: 70_000_000,
            unit: "usd_nanodollars",
            values: [70_000_000],
          };
    return {
      matched: true,
      data: { buckets: [since], interval: "hour", series: [series], since, until },
    };
  }
  if (["/v1/usage", "/v1/costs", "/v1/spend", "/v1/api-key-usage"].includes(path)) {
    const fixture = {
      "/v1/api-key-usage": {
        data: {
          apiCredentialId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
          createdAt: now,
          environmentId,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
          organizationId,
          outcome: "allowed",
          projectId,
          requestMethod: "GET",
          requestPath: "/v1/whoami",
        },
        type: "api-credential-usage",
      },
      "/v1/costs": {
        data: {
          bucket: now,
          costs: { model: 7 },
          currency: "USD",
          environmentId,
          organizationId,
          projectId,
          source: "model",
          totalMinor: 7,
        },
        type: "cost-aggregate",
      },
      "/v1/spend": {
        data: {
          amount: { amountMinor: 9, currency: "USD" },
          environmentId,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
          occurredAt: now,
          organizationId,
          projectId,
          provider: "mock",
        },
        type: "spend-ledger",
      },
      "/v1/usage": {
        data: {
          bucket: now,
          environmentId,
          metric: "model.tokens",
          organizationId,
          projectId,
          quantity: 12,
          unit: "tokens",
        },
        type: "usage-aggregate",
      },
    } as const;
    return { matched: true, data: { items: [fixture[path as keyof typeof fixture]] } };
  }
  const auditEvent = {
    action: "api-key.rotated",
    actor: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAY", type: "principal" },
    environmentId,
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    occurredAt: now,
    organizationId,
    projectId,
    resourceId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
    resourceType: "api-credential",
  } as const;
  if (path === "/v1/audit-events") return { matched: true, data: { items: [auditEvent] } };
  if (/^\/v1\/audit-events\/[^/]+$/u.test(path)) {
    return {
      matched: true,
      data: {
        ...auditEvent,
        id: decodeURIComponent(path.split("/").at(-1) ?? auditEvent.id),
      },
    };
  }
  return { matched: false };
}
