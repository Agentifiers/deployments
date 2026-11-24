import { describe, expect, test } from "bun:test";
import type { OrganizationActivity } from "./activity-policy.ts";

const repositoryRoot = new URL("../../../", import.meta.url);
const modulesRoot = new URL("infrastructure/modules/", repositoryRoot);
const TRIGGER =
  /^resource "(aws_lambda_event_source_mapping|aws_cloudwatch_event_target|aws_scheduler_schedule)" "([\w-]+)" \{$/gmu;

function block(text: string, start: number) {
  const end = text.indexOf("\n}", start);
  return text.slice(start, end === -1 ? undefined : end);
}

function quoted(text: string) {
  return [...text.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
}

/** Keys of a map whose entries sit four spaces in, until the closing brace two spaces in. */
function mapKeys(lines: readonly string[]) {
  const keys: string[] = [];
  for (const line of lines) {
    if (/^ {0,2}\}/u.test(line)) break;
    const entry = /^ {4}"?([\w-]+)"?\s*=/u.exec(line);
    if (entry) keys.push(entry[1]!);
  }
  return keys;
}

/** The static keys a `for_each` fans out over, or undefined when it has none. */
function forEachKeys(moduleText: string, resourceBlock: string): readonly string[] | undefined {
  const lines = resourceBlock.split("\n");
  const index = lines.findIndex((line) => /^ {2}for_each\s*=/u.test(line));
  if (index === -1) return undefined;
  const expression = lines[index]!.replace(/^ {2}for_each\s*=\s*/u, "");
  const rule = /^aws_cloudwatch_event_rule\.([\w-]+)$/u.exec(expression);
  if (rule) {
    const start = moduleText.indexOf(`resource "aws_cloudwatch_event_rule" "${rule[1]}" {`);
    return forEachKeys(moduleText, block(moduleText, start));
  }
  const local = /^local\.([\w-]+)$/u.exec(expression);
  if (local) {
    const moduleLines = moduleText.split("\n");
    const at = moduleLines.findIndex((line) => new RegExp(`^ {2}${local[1]}\\s*=`, "u").test(line));
    const value = moduleLines[at]!.replace(/^[^=]*=\s*/u, "");
    if (value.startsWith("toset([")) return quoted(value);
    if (value === "{" && !/^\s*for /u.test(moduleLines[at + 1]!)) {
      return mapKeys(moduleLines.slice(at + 1));
    }
    return undefined;
  }
  if (!expression.endsWith("{")) {
    return expression.includes("{") ? quoted(expression.replace(/=\s*"[^"]*"/gu, "")) : undefined;
  }
  const listed = /^\s*for \w+ in \[([^\]]*)\]/u.exec(lines[index + 1]!);
  return listed ? quoted(listed[1]!) : mapKeys(lines.slice(index + 1));
}

async function backgroundTriggers() {
  const files = new Map<string, string>();
  for await (const path of new Bun.Glob("**/*.tf").scan({ cwd: modulesRoot.pathname })) {
    files.set(path, await Bun.file(new URL(path, modulesRoot)).text());
  }
  const triggers: string[] = [];
  for (const [path, text] of files) {
    const module = path.slice(0, path.lastIndexOf("/"));
    const moduleText = [...files]
      .filter(([other]) => other.slice(0, other.lastIndexOf("/")) === module)
      .map(([, other]) => other)
      .join("\n");
    for (const match of text.matchAll(TRIGGER)) {
      const address = `${path} ${match[1]}.${match[2]}`;
      const keys = forEachKeys(moduleText, block(text, match.index));
      triggers.push(...(keys ? keys.map((key) => `${address}[${key}]`) : [address]));
    }
  }
  return triggers.toSorted();
}

type Decision =
  /** The handler at `at` reads standing for `gate` before it does the organization's work. */
  | { readonly gate: OrganizationActivity; readonly at: string }
  /** Why this path runs regardless of standing. */
  | { readonly exempt: string };

const RUN_CLAIM = {
  at: "functions/worker/src/agent-run-standing.ts",
  gate: "run.continue",
} as const;
const RUN_ADMISSION = {
  at: "packages/conversations/src/run-admission.ts",
  gate: "run.admit",
} as const;
const EMAIL_SEND = {
  at: "functions/agent-email-runtime/src/send-main.ts",
  gate: "outbound.deliver",
} as const;
const DISPATCH = { exempt: "Only sends work to a queue whose worker decides." };
const TELEMETRY = { exempt: "Records what already happened: traces, usage, and analytics." };
const OPERATOR_SEARCH = {
  exempt: "Operator search provisioning and migration: where an index lives, not agent work.",
};
const EMAIL_MAINTENANCE = {
  exempt: "Sends due mail back to the send worker, which refuses it, and purges expired mail.",
};
const EMAIL_PROVIDER_EVENTS = {
  exempt: "Records the provider's delivery and bounce reports for mail already sent.",
};
const IDENTITY_MAIL = { exempt: "Install identity mail such as sign-in and verification." };
const ALERT_NOTICES = {
  exempt:
    "Platform notices to the organization's own members; alert webhook copies go through the delivery worker, which refuses them.",
};

/** Every Lambda event source mapping, EventBridge target, and schedule under infrastructure/modules. */
const DECISIONS: Readonly<Record<string, Decision>> = {
  "agent-email/runtime.tf aws_lambda_event_source_mapping.managed_events_stream": DISPATCH,
  "agent-email/runtime.tf aws_lambda_event_source_mapping.managed_inbound": RUN_ADMISSION,
  "agent-email/runtime.tf aws_lambda_event_source_mapping.managed_maintenance": EMAIL_MAINTENANCE,
  "agent-email/runtime.tf aws_lambda_event_source_mapping.managed_queue_worker[provider-events]":
    EMAIL_PROVIDER_EVENTS,
  "agent-email/runtime.tf aws_lambda_event_source_mapping.managed_queue_worker[send]": EMAIL_SEND,
  "agent-email/runtime.tf aws_scheduler_schedule.managed_maintenance": DISPATCH,
  "agent-email/workers.tf aws_lambda_event_source_mapping.events_stream": DISPATCH,
  "agent-email/workers.tf aws_lambda_event_source_mapping.queue[events]": EMAIL_PROVIDER_EVENTS,
  "agent-email/workers.tf aws_lambda_event_source_mapping.queue[inbound]": RUN_ADMISSION,
  "agent-email/workers.tf aws_lambda_event_source_mapping.queue[send]": EMAIL_SEND,
  "agent-email/workers.tf aws_scheduler_schedule.maintenance": EMAIL_MAINTENANCE,
  "agent-observability/main.tf aws_lambda_event_source_mapping.normalizer[execution]": TELEMETRY,
  "agent-observability/main.tf aws_lambda_event_source_mapping.normalizer[usage]": TELEMETRY,
  "agent-observability/main.tf aws_lambda_event_source_mapping.projector": TELEMETRY,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[00]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[01]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[02]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[03]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[04]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[05]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[06]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[07]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[08]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[09]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[10]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[11]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[12]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[13]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[14]": ALERT_NOTICES,
  "agent-runtime/alerts.tf aws_cloudwatch_event_target.alerts_sweep[15]": ALERT_NOTICES,
  "agent-runtime/evaluations.tf aws_lambda_event_source_mapping.evaluations": RUN_ADMISSION,
  "agent-runtime/model-catalog-sync.tf aws_cloudwatch_event_target.model_catalog_sync": {
    exempt: "Install-wide model catalog; no organization.",
  },
  "agent-runtime/run-dispatch.tf aws_cloudwatch_event_target.run_requested": RUN_CLAIM,
  "agent-runtime/runtime-api.tf aws_lambda_event_source_mapping.artifact_retention": {
    exempt: "Deletes artifacts past their retention.",
  },
  "agent-runtime/runtime-api.tf aws_lambda_event_source_mapping.trace_finalization": TELEMETRY,
  "agent-runtime/runtime-api.tf aws_lambda_event_source_mapping.usage": TELEMETRY,
  "agent-runtime/worker-functions.tf aws_cloudwatch_event_target.webhook_events": {
    exempt: "Records one delivery per endpoint; the delivery worker refuses them.",
  },
  "agent-runtime/worker-functions.tf aws_lambda_event_source_mapping.webhook_deliveries": {
    at: "functions/runtime-api/src/webhook-delivery-worker.ts",
    gate: "outbound.deliver",
  },
  "agent-runtime/workflow-runtime.tf aws_cloudwatch_event_target.workflow_runtime": DISPATCH,
  "agent-runtime/workflow-runtime.tf aws_lambda_event_source_mapping.workflow": {
    at: "functions/workflow-runtime/src/runtime-composition.ts",
    gate: "background.process",
  },
  "app-runtime/domain-reconciler.tf aws_scheduler_schedule.domain_reconciler": {
    exempt: "Keeps custom domain certificates and DNS current; the app gateway refuses to serve.",
  },
  "brain-runtime/main.tf aws_cloudwatch_event_target.brain_erasure": {
    exempt: "Erasure runs under any hold.",
  },
  "brain-runtime/main.tf aws_cloudwatch_event_target.content_maintenance": {
    exempt:
      "Removes abandoned uploads and proposes duplicate reviews; nothing is spent or published.",
  },
  "brain-runtime/main.tf aws_cloudwatch_event_target.index": DISPATCH,
  "brain-runtime/main.tf aws_cloudwatch_event_target.index_sweep": DISPATCH,
  "brain-runtime/main.tf aws_lambda_event_source_mapping.worker": {
    at: "functions/api/src/brain/index-runtime.ts",
    gate: "background.process",
  },
  "brain-runtime/placement.tf aws_cloudwatch_event_target.search_placement": OPERATOR_SEARCH,
  "brain-runtime/sync.tf aws_cloudwatch_event_target.sync_created": DISPATCH,
  "brain-runtime/sync.tf aws_cloudwatch_event_target.sync_sweep": DISPATCH,
  "brain-runtime/sync.tf aws_lambda_event_source_mapping.sync": {
    at: "functions/api/src/brain/sync-runtime.ts",
    gate: "background.process",
  },
  "channel-provider-runtime/main.tf aws_cloudwatch_event_target.runtime[channel-delivery]":
    DISPATCH,
  "channel-provider-runtime/main.tf aws_cloudwatch_event_target.runtime[provider-tools]": DISPATCH,
  "channel-provider-runtime/runtime-functions.tf aws_lambda_event_source_mapping.worker[channel-delivery]":
    {
      exempt:
        "Delivers a run's reply to its channel; run.continue decides whether the run goes on.",
    },
  "channel-provider-runtime/runtime-functions.tf aws_lambda_event_source_mapping.worker[provider-tools]":
    { exempt: "Runs a tool call a run made; run.continue decides whether the run goes on." },
  "event-analytics/ingestion.tf aws_cloudwatch_event_target.projector": TELEMETRY,
  "inbound-runtime/main.tf aws_lambda_event_source_mapping.flush": RUN_ADMISSION,
  "inbound-runtime/main.tf aws_lambda_event_source_mapping.runtime": RUN_ADMISSION,
  "memory-runtime/main.tf aws_cloudwatch_event_target.reconcile": DISPATCH,
  "memory-runtime/main.tf aws_lambda_event_source_mapping.worker[memory-cleanup]": {
    exempt: "Deletes memory blobs and review content that are no longer referenced.",
  },
  "memory-runtime/main.tf aws_lambda_event_source_mapping.worker[memory-flush]": {
    at: "functions/worker/src/model-token-issuer-service.ts",
    gate: "model.mint",
  },
  "memory-runtime/main.tf aws_lambda_event_source_mapping.worker[memory-index]": {
    at: "functions/memory-runtime/src/index-worker.ts",
    gate: "background.process",
  },
  "memory-runtime/main.tf aws_lambda_event_source_mapping.worker[memory-operation]":
    OPERATOR_SEARCH,
  "memory-runtime/main.tf aws_lambda_event_source_mapping.worker[memory-reconcile]": {
    exempt: "Queues index jobs after a policy or space change; the index worker decides.",
  },
  "memory-runtime/main.tf aws_lambda_event_source_mapping.worker[memory-search-placement]":
    OPERATOR_SEARCH,
  "memory-runtime/main.tf aws_lambda_event_source_mapping.worker[memory-shadow]": {
    exempt: "Repeats one search a run already made against a candidate strategy, for comparison.",
  },
  "memory-runtime/main.tf aws_lambda_event_source_mapping.worker[memory-usage]": TELEMETRY,
  "memory-runtime/operation-scheduling.tf aws_cloudwatch_event_target.memory_operation_reconcile":
    DISPATCH,
  "memory-runtime/queues.tf aws_cloudwatch_event_target.queue[memory-cleanup]": DISPATCH,
  "memory-runtime/queues.tf aws_cloudwatch_event_target.queue[memory-flush]": DISPATCH,
  "memory-runtime/queues.tf aws_cloudwatch_event_target.queue[memory-index]": DISPATCH,
  "memory-runtime/queues.tf aws_cloudwatch_event_target.queue[memory-reconcile]": DISPATCH,
  "memory-runtime/queues.tf aws_cloudwatch_event_target.queue[memory-search-placement]": DISPATCH,
  "memory-runtime/queues.tf aws_cloudwatch_event_target.queue[memory-shadow]": DISPATCH,
  "platform-api/governance-runtime.tf aws_cloudwatch_event_target.governance_operation_dispatch":
    DISPATCH,
  "platform-api/governance-runtime.tf aws_cloudwatch_event_target.governance_retention": DISPATCH,
  "platform-api/governance-runtime.tf aws_lambda_event_source_mapping.governance": {
    at: "functions/api/src/governance-worker-main.ts",
    gate: "background.process",
  },
  "platform-events/main.tf aws_lambda_event_source_mapping.dispatcher": DISPATCH,
  "platform-identity/workers.tf aws_cloudwatch_event_target.reconcile": {
    exempt: "Install identity: people and sign-in, not organization work.",
  },
  "platform-identity/workers.tf aws_lambda_event_source_mapping.email_queue": IDENTITY_MAIL,
  "platform-identity/workers.tf aws_lambda_event_source_mapping.email_stream": DISPATCH,
  "platform-identity/workers.tf aws_lambda_event_source_mapping.public_email_request_queue":
    IDENTITY_MAIL,
};

describe("background claim paths", () => {
  test("every trigger under infrastructure/modules has a standing decision", async () => {
    const triggers = await backgroundTriggers();
    const decided = Object.keys(DECISIONS).toSorted();

    expect({
      stale: decided.filter((address) => !triggers.includes(address)),
      undecided: triggers.filter((address) => !Object.hasOwn(DECISIONS, address)),
    }).toEqual({ stale: [], undecided: [] });
  });

  test("every gated path names a handler that exists", async () => {
    const handlers = new Set(
      Object.values(DECISIONS).flatMap((decision) => ("at" in decision ? [decision.at] : [])),
    );
    const missing: string[] = [];
    for (const path of handlers) {
      if (!(await Bun.file(new URL(path, repositoryRoot)).exists())) missing.push(path);
    }

    expect(missing).toEqual([]);
  });
});
