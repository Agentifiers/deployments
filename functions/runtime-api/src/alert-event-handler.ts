import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeAlertDeliveryPersistence,
  makeDynamoDatabase,
  makeMonitorPersistence,
  monitorObservers,
  tableNamesFromEnvironment,
  type MonitorEvaluationDependencies,
  type TraceMetricBucket,
  type TraceMetricsReader,
} from "@deployments-ai/db";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import {
  ALERT_EMAIL_EVENT_TYPES,
  sendAlertEmails,
  type AlertEmailDependencies,
} from "./alert-email.ts";
import { evaluateMonitorEvent, sweepMonitorShard } from "./alert-evaluation.ts";
import { required } from "./required-environment.ts";

export const ALERT_ENV = {
  consoleOrigin: "DEPLOYMENTS_AI_ALERT_CONSOLE_ORIGIN",
  observabilityBaseUrl: "DEPLOYMENTS_AI_OBSERVABILITY_BASE_URL",
  observabilitySecretArn: "DEPLOYMENTS_AI_OBSERVABILITY_SECRET_ARN",
  productName: "DEPLOYMENTS_AI_ALERT_PRODUCT_NAME",
  sender: "DEPLOYMENTS_AI_ALERT_EMAIL_SENDER",
} as const;

const SES_SEND_TIMEOUT_MS = 10_000;

export interface AlertRuntimeDependencies {
  readonly email: AlertEmailDependencies;
  readonly evaluation: MonitorEvaluationDependencies;
}

/** Bounded so one slow hot plane cannot hold a sweep shard past the monitors after it. */
const HOT_PLANE_TIMEOUT_MS = 5_000;

/**
 * Hourly finalized-trace buckets for one environment, or one deployment in it, from the
 * observability hot plane, or undefined when this install runs without it.
 */
export function hotPlaneTraceMetrics(
  env: NodeJS.ProcessEnv,
  load: (secretArn: string) => Promise<string> = loadAwsSecretString,
  fetchMetrics: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): TraceMetricsReader {
  const baseUrl = env[ALERT_ENV.observabilityBaseUrl]?.trim().replace(/\/+$/u, "");
  const secretArn = env[ALERT_ENV.observabilitySecretArn]?.trim();
  if (!baseUrl || !secretArn) return async () => undefined;
  let token: Promise<string> | undefined;
  return async (input) => {
    token ??= load(secretArn).then(
      (value) => {
        try {
          const parsed = JSON.parse(value) as Readonly<Record<string, unknown>>;
          const candidate = parsed.apiKey ?? parsed.serviceToken ?? parsed.value ?? parsed.token;
          return typeof candidate === "string" ? candidate.trim() : value.trim();
        } catch {
          return value.trim();
        }
      },
      (cause: unknown) => {
        token = undefined;
        throw cause;
      },
    );
    const url = new URL(`${baseUrl}/metrics`);
    url.searchParams.set("from", input.from.toISOString());
    url.searchParams.set("to", input.to.toISOString());
    url.searchParams.set("interval", "hour");
    if (input.agentDeploymentId) url.searchParams.set("agentDeploymentId", input.agentDeploymentId);
    const response = await fetchMetrics(url, {
      headers: {
        authorization: `Bearer ${await token}`,
        "x-deployments-environment": input.environmentId,
        "x-deployments-organization": input.organizationId,
        "x-deployments-project": input.projectId,
      },
      signal: AbortSignal.timeout(HOT_PLANE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Observability metrics returned ${response.status}.`);
    const body = (await response.json()) as { readonly items?: readonly TraceMetricBucket[] };
    return body.items ?? [];
  };
}

function createAwsAlertRuntimeDependencies(
  env: NodeJS.ProcessEnv = process.env,
): AlertRuntimeDependencies {
  const database = makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(env),
  );
  const monitors = makeMonitorPersistence({ database });
  const ses = new SESv2Client({});
  const sender = required(ALERT_ENV.sender, env);
  return {
    email: {
      delivery: makeAlertDeliveryPersistence({ database }),
      install: {
        consoleOrigin: required(ALERT_ENV.consoleOrigin, env).replace(/\/+$/u, ""),
        productName: env[ALERT_ENV.productName]?.trim() || "Deployments.ai",
      },
      monitors,
      send: async ({ html, preferencesUrl, recipient, subject, text }) => {
        await ses.send(
          new SendEmailCommand({
            Content: {
              Simple: {
                Body: {
                  Html: { Charset: "UTF-8", Data: html },
                  Text: { Charset: "UTF-8", Data: text },
                },
                Headers: [{ Name: "List-Unsubscribe", Value: `<${preferencesUrl}>` }],
                Subject: { Charset: "UTF-8", Data: subject },
              },
            },
            Destination: { ToAddresses: [recipient] },
            FromEmailAddress: sender,
          }),
          // Bounded well below the alert email claim timeout, so a hung request cannot outlive
          // its claim and let a retry send the same email alongside it.
          { abortSignal: AbortSignal.timeout(SES_SEND_TIMEOUT_MS) },
        );
      },
    },
    evaluation: {
      monitors,
      now: () => new Date(),
      observe: monitorObservers({ database, traceMetrics: hotPlaneTraceMetrics(env) }),
    },
  };
}

type AlertInput =
  | { readonly detail: unknown; readonly "detail-type"?: string; readonly source?: string }
  | { readonly shard: number; readonly sweep: true };

/**
 * One artifact serves three triggers: the scheduled sweep of one shard
 * (`{ sweep: true, shard }`), alert events to email, and every other platform event a monitor
 * listens for to evaluation.
 */
export function createAlertEventHandler(
  dependencies: () => AlertRuntimeDependencies = createAwsAlertRuntimeDependencies,
) {
  let resolved: AlertRuntimeDependencies | undefined;
  return async (
    input: AlertInput,
    context?: { readonly getRemainingTimeInMillis: () => number },
  ) => {
    resolved ??= dependencies();
    if ("sweep" in input) {
      return sweepMonitorShard(resolved.evaluation, {
        remainingTimeMs: () => context?.getRemainingTimeInMillis() ?? Number.POSITIVE_INFINITY,
        shard: input.shard,
      });
    }
    const eventType =
      input["detail-type"] ?? (input.detail as { readonly eventType?: string } | null)?.eventType;
    if (eventType && ALERT_EMAIL_EVENT_TYPES.includes(eventType)) {
      await sendAlertEmails(input, resolved.email);
      return;
    }
    await evaluateMonitorEvent(input, resolved.evaluation);
  };
}

export const handler = createAlertEventHandler();
