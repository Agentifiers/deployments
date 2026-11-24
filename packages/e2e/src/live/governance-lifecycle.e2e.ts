import { expect, it } from "@effect/vitest";
import { createHash, randomUUID, verify as verifySignature } from "node:crypto";
import { Effect, Exit } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import {
  E2eHttpClient,
  httpClientLayer,
  type E2eHttpClientService,
} from "../harness/http-client.ts";
import { record, stringField } from "../harness/live-agent.ts";
import { json, records } from "../harness/response-records.ts";
import { credentialedE2eEnabled, e2eApiUrl, scopedE2eConfig } from "../harness/live-config.ts";
import { liveAgentModel } from "../harness/live-model.ts";
import {
  bearerAuthorization,
  tenantHeaders,
  type PlatformCredential,
} from "../harness/platform-credential.ts";
import {
  ERASURE_COMPLETION_TIMEOUT_MS,
  expectMemorySearchErasure,
  expectObservabilityErasure,
  seedObservedRun,
} from "./governance-erasure-observability-support.ts";

type JsonRecord = Record<string, unknown>;

const enabled = credentialedE2eEnabled();

function organizationHeaders(credential: PlatformCredential | string, organizationId: string) {
  return bearerAuthorization(credential, { "x-deployments-organization": organizationId });
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Unsupported canonical JSON value.");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function output(operation: JsonRecord, label: string) {
  return record(operation.output, `${label}.output`);
}

function operationStatus(
  http: E2eHttpClientService,
  input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly kind: "audit-exports" | "data-exports" | "erasures";
    readonly operationId: string;
    readonly organizationId: string;
  },
) {
  const timeoutMs = input.kind === "erasures" ? ERASURE_COMPLETION_TIMEOUT_MS : 300_000;
  return eventually(
    { intervalMs: 5_000, label: `${input.kind} operation ${input.operationId}`, timeoutMs },
    http
      .request({
        headers: input.headers,
        method: "GET",
        path: `/v1/organizations/${input.organizationId}/${input.kind}/${input.operationId}`,
      })
      .pipe(
        Effect.map((response) => {
          const operation = json(response, 200, `${input.kind} operation get`);
          if (operation.status === "completed") return operation;
          // Pending covers drain/purge waits such as `observability_erasure_pending`.
          if (operation.status === "pending" || operation.status === "running") return undefined;
          throw new Error(`${input.kind} operation ${String(operation.status)}: ${response.body}`);
        }),
      ),
  );
}

interface ErasureRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
  readonly organizationId: string;
}

function submitErasure(http: E2eHttpClientService, input: ErasureRequest) {
  return http
    .request({
      body: { confirmation: "ERASE" },
      headers: { ...input.headers, "idempotency-key": input.idempotencyKey },
      method: "POST",
      path: `/v1/organizations/${input.organizationId}/erasures`,
    })
    .pipe(Effect.map((response) => json(response, 202, "tenant erasure request")));
}

function requestErasure(http: E2eHttpClientService, input: ErasureRequest) {
  return Effect.gen(function* () {
    const requested = yield* submitErasure(http, input);
    return yield* operationStatus(http, {
      headers: input.headers,
      kind: "erasures",
      operationId: stringField(requested, "id", "tenant erasure"),
      organizationId: input.organizationId,
    });
  });
}

function resubmitErasureOnFailure(http: E2eHttpClientService, input: ErasureRequest) {
  return Effect.acquireRelease(Effect.void, (_, exit) =>
    Exit.isSuccess(exit)
      ? Effect.void
      : submitErasure(http, input).pipe(Effect.asVoid, Effect.orDie),
  );
}

function download(url: string, label: string) {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
      return Buffer.from(await response.arrayBuffer());
    },
    catch: (cause) => new Error(`${label} failed.`, { cause }),
  });
}

it.effect.skipIf(!enabled)(
  "proves governance retention, tenant export, signed audit export, observability-purging erasure, usage, and spend",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-governance-${randomUUID()}`;
      const platformAuth = bearerAuthorization(config.platformCredential);
      const operationalAuth = tenantHeaders(config.platformCredential, config);

      for (const path of ["/v1/usage?limit=10", "/v1/spend?limit=10", "/v1/costs?limit=10"]) {
        const page = json(
          yield* http.request({ headers: operationalAuth, method: "GET", path }),
          200,
          `operational read ${path}`,
        );
        expect(Array.isArray(page.items)).toBe(true);
      }

      const organization = json(
        yield* http.request({
          body: {
            name: `E2E governance ${runKey}`,
            slug: `e2e-gov-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
          },
          headers: { ...platformAuth, "idempotency-key": `${runKey}:organization` },
          method: "POST",
          path: "/v1/organizations",
        }),
        201,
        "governance organization create",
      );
      const organizationId = stringField(organization, "id", "governance organization");
      const governanceAuth = organizationHeaders(config.platformCredential, organizationId);
      const erasureKey = `${runKey}:erasure`;

      yield* resubmitErasureOnFailure(http, {
        headers: governanceAuth,
        idempotencyKey: erasureKey,
        organizationId,
      });

      const observed = yield* seedObservedRun(cli, config, organizationId, runKey);
      expect(observed.traceId).toMatch(/^[0-9a-f]{32}$/u);

      const defaultPolicy = json(
        yield* http.request({
          headers: governanceAuth,
          method: "GET",
          path: `/v1/organizations/${organizationId}/retention-policy`,
        }),
        200,
        "default retention policy",
      );
      expect(defaultPolicy).toMatchObject({ audit: 2555, organizationId });
      const updatedPolicy = json(
        yield* http.request({
          body: {
            artifacts: 30,
            audit: 365,
            events: 30,
            messages: 30,
            runs: 30,
            threads: 30,
          },
          headers: { ...governanceAuth, "idempotency-key": `${runKey}:retention` },
          method: "PATCH",
          path: `/v1/organizations/${organizationId}/retention-policy`,
        }),
        200,
        "retention policy update",
      );
      expect(updatedPolicy).toMatchObject({
        artifacts: 30,
        audit: 365,
        events: 30,
        messages: 30,
        organizationId,
        runs: 30,
        threads: 30,
      });

      const exportRequested = json(
        yield* http.request({
          headers: { ...governanceAuth, "idempotency-key": `${runKey}:tenant-export` },
          method: "POST",
          path: `/v1/organizations/${organizationId}/data-exports`,
        }),
        202,
        "tenant export request",
      );
      const tenantExportId = stringField(exportRequested, "id", "tenant export");
      const tenantExport = yield* operationStatus(http, {
        headers: governanceAuth,
        kind: "data-exports",
        operationId: tenantExportId,
        organizationId,
      });
      const tenantOutput = output(tenantExport, "tenant export");
      const tenantBytes = yield* download(
        stringField(tenantOutput, "downloadUrl", "tenant export output"),
        "tenant export download",
      );
      expect(tenantBytes.byteLength).toBe(tenantOutput.sizeBytes);
      expect(sha256(tenantBytes)).toBe(tenantOutput.sha256);
      expect(tenantBytes.toString("utf8")).toContain(organizationId);
      const tenantLines = tenantBytes
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
      expect(tenantLines.length).toBeGreaterThan(0);

      const auditRequested = json(
        yield* http.request({
          headers: { ...governanceAuth, "idempotency-key": `${runKey}:audit-export` },
          method: "POST",
          path: `/v1/organizations/${organizationId}/audit-exports`,
        }),
        202,
        "audit export request",
      );
      const auditExportId = stringField(auditRequested, "id", "audit export");
      const auditExport = yield* operationStatus(http, {
        headers: governanceAuth,
        kind: "audit-exports",
        operationId: auditExportId,
        organizationId,
      });
      const auditOutput = output(auditExport, "audit export");
      expect(auditOutput).toMatchObject({ contentType: "application/json", immutable: true });
      const manifestBytes = yield* download(
        stringField(auditOutput, "downloadUrl", "audit output"),
        "audit manifest download",
      );
      const archiveBytes = yield* download(
        stringField(auditOutput, "archiveDownloadUrl", "audit output"),
        "audit archive download",
      );
      expect(manifestBytes.byteLength).toBe(auditOutput.sizeBytes);
      expect(archiveBytes.byteLength).toBe(auditOutput.archiveSizeBytes);
      expect(sha256(manifestBytes)).toBe(auditOutput.sha256);
      expect(sha256(archiveBytes)).toBe(auditOutput.archiveSha256);

      const manifest = record(
        JSON.parse(manifestBytes.toString("utf8")) as unknown,
        "audit manifest",
      );
      expect(manifest).toMatchObject({
        algorithm: "sha256-chain-v1",
        canonicalization: "canonical-json-v1",
        organizationId,
      });
      const archiveLines = archiveBytes
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line, index) => record(JSON.parse(line) as unknown, `audit archive[${index}]`));
      let previousHash = "0".repeat(64);
      for (const entry of archiveLines) {
        expect(entry.previousHash).toBe(previousHash);
        const expectedHash = sha256(`${previousHash}\n${canonicalJson(entry.value)}`);
        expect(entry.entryHash).toBe(expectedHash);
        previousHash = expectedHash;
      }
      expect(previousHash).toBe(manifest.rootHash);
      expect(archiveLines).toHaveLength(Number(manifest.recordCount));

      const { signature, ...unsignedManifest } = manifest;
      expect(typeof signature).toBe("string");
      expect(
        verifySignature(
          "sha256",
          Buffer.from(canonicalJson(unsignedManifest), "utf8"),
          {
            format: "der",
            key: Buffer.from(
              stringField(manifest, "signaturePublicKey", "audit manifest"),
              "base64",
            ),
            type: "spki",
          },
          Buffer.from(String(signature), "base64"),
        ),
      ).toBe(true);

      const auditEvents = records(
        json(
          yield* http.request({
            headers: governanceAuth,
            method: "GET",
            path: `/v1/organizations/${organizationId}/audit-events?limit=100`,
          }),
          200,
          "organization audit events",
        ).items,
        "organization audit events.items",
      );
      expect(auditEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "retention-policy.updated",
            organizationId,
            resourceId: organizationId,
            resourceType: "retention-policy",
          }),
          expect.objectContaining({
            action: "tenant-export.requested",
            organizationId,
            resourceId: tenantExportId,
            resourceType: "governance-operation",
          }),
          expect.objectContaining({
            action: "audit-export.requested",
            organizationId,
            resourceId: auditExportId,
            resourceType: "governance-operation",
          }),
        ]),
      );

      const operations = records(
        json(
          yield* http.request({
            headers: governanceAuth,
            method: "GET",
            path: `/v1/organizations/${organizationId}/governance-operations?limit=100`,
          }),
          200,
          "governance operations",
        ).items,
        "governance operations.items",
      );
      expect(operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: tenantExportId,
            kind: "tenant-export",
            organizationId,
            status: "completed",
          }),
          expect.objectContaining({
            id: auditExportId,
            kind: "audit-export",
            organizationId,
            status: "completed",
          }),
        ]),
      );

      const seededUsage = yield* eventually(
        { intervalMs: 2_000, label: `run ${observed.runId} model usage`, timeoutMs: 60_000 },
        http
          .request({
            headers: tenantHeaders(config.platformCredential, {
              environmentId: observed.environmentId,
              organizationId,
              projectId: observed.projectId,
            }),
            method: "GET",
            path: "/v1/usage?limit=100&metric=model_tokens",
          })
          .pipe(
            Effect.map((response) =>
              records(json(response, 200, "seeded run usage").items, "seeded run usage.items").find(
                (item) =>
                  item.type === "meter-event" &&
                  record(item.data, "seeded run usage.data").runId === observed.runId,
              ),
            ),
          ),
      );
      const meterEvent = record(seededUsage.data, "seeded run meter-event");
      expect(meterEvent).toMatchObject({
        environmentId: observed.environmentId,
        metric: "model_tokens",
        organizationId,
        projectId: observed.projectId,
        runId: observed.runId,
        unit: "tokens",
      });
      const dimensions = record(meterEvent.dimensions, "seeded run meter-event.dimensions");
      expect(dimensions.modelId).toBe(liveAgentModel.model.id);
      expect(dimensions.inputTokens).toBeGreaterThan(0);
      expect(dimensions.outputTokens).toBeGreaterThan(0);

      const erased = yield* requestErasure(http, {
        headers: governanceAuth,
        idempotencyKey: erasureKey,
        organizationId,
      });
      expect(erased).toMatchObject({ kind: "tenant-erasure", organizationId, status: "completed" });
      expect(record(erased.summary, "erasure summary")).toMatchObject({
        auditRootHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        recordsDeleted: expect.any(Number),
      });
      expectObservabilityErasure(erased);
      expectMemorySearchErasure(erased);

      const erasureReplay = json(
        yield* http.request({
          body: { confirmation: "ERASE" },
          headers: { ...governanceAuth, "idempotency-key": erasureKey },
          method: "POST",
          path: `/v1/organizations/${organizationId}/erasures`,
        }),
        202,
        "tenant erasure replay",
      );
      expect(erasureReplay).toMatchObject({ id: erased.id, status: "completed" });

      const erasedMutation = yield* http.request({
        body: { runs: 31 },
        headers: {
          ...governanceAuth,
          "idempotency-key": `${runKey}:after-erasure`,
        },
        method: "PATCH",
        path: `/v1/organizations/${organizationId}/retention-policy`,
      });
      expect(erasedMutation.status, erasedMutation.body).toBe(410);
      expect(erasedMutation.json).toMatchObject({ code: "organization_erased" });

      expect(
        records(
          json(
            yield* http.request({
              headers: platformAuth,
              method: "GET",
              path: "/v1/organizations",
            }),
            200,
            "organization list after erasure",
          ).items,
          "organization list after erasure.items",
        ).map((entry) => entry.id),
      ).not.toContain(organizationId);
    }).pipe(Effect.provide(httpClientLayer(e2eApiUrl())), Effect.provide(CliProcessLive)),
  75 * 60_000,
);
