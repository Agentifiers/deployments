import { link, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { Schema } from "effect";
import {
  createDeterministicZip,
  deploymentArtifacts,
  type DeploymentArtifactName,
} from "../build-deployment-artifacts.ts";
import { type CommandRunner, log, runCommand } from "./process.ts";
import type { TerraformOutputs } from "./terraform.ts";
import { sha256File, type VerifiedRelease } from "./release-bundle.ts";
import { consoleEndpoint } from "./verify.ts";

// Functions sharing one archive deploy independently, so publishing them one at a time made a
// change to a shared archive cost minutes. This bounds concurrent Lambda control-plane writes.
const LAMBDA_PUBLISH_CONCURRENCY = 8;

const agentObservabilityFunctionSuffixes = new Set([
  "agent-observability-erasure",
  "agent-observability-normalizer-execution",
  "agent-observability-normalizer-usage",
  "agent-observability-projector",
]);

export const artifactFunctionSuffixes = {
  "agent-email-runtime": [
    "agent-email-api",
    "agent-email-inbound",
    "agent-email-maintenance",
    "agent-email-provider-events",
    "agent-email-send",
    "agent-email-stream-dispatcher",
  ],
  "agent-runtime": [
    "agent-runtime-api",
    "agent-runtime-artifact-retention",
    "agent-runtime-client-tool-timeout",
    "agent-runtime-evaluation-worker",
    "agent-runtime-heartbeat-fire",
    "agent-observability-erasure",
    "agent-observability-normalizer-execution",
    "agent-observability-normalizer-usage",
    "agent-observability-projector",
    "agent-runtime-model-catalog-sync",
    "agent-runtime-model-token-agent-worker",
    "agent-runtime-model-token-brain",
    "agent-runtime-model-token-evaluations",
    "agent-runtime-model-token-memory",
    "agent-runtime-model-token-run",
    "agent-runtime-model-token-web-tools",
    "agent-runtime-run-dispatch",
    "agent-runtime-schedule-fire",
    "agent-runtime-trace-finalization",
    "agent-runtime-usage-materializer",
    "agent-runtime-webhook-deliveries",
    "agent-runtime-webhook-events",
    "agent-runtime-workflow-event-router",
    "agent-runtime-workflow-approval-timeout",
    "agent-runtime-workflow-queue",
  ],
  "app-domains": ["apps-domains"],
  "apps-database": ["apps-database"],
  "channel-provider-runtime": [
    "channel-command",
    "channel-ingress-flush",
    "channel-delivery",
    "channel-ingress",
    "credential-api",
    "oauth-api",
    "oauth-refresh",
    "provider-tools",
  ],
  console: ["console"],
  "document-extraction": ["document-extraction"],
  "event-analytics-projector": ["event-analytics-projector"],
  "event-dispatcher": ["event-dispatcher"],
  "identity-api": ["api", "principal-status", "public-email-worker"],
  "identity-email-worker": ["email-dispatcher", "email-reconciler", "email-worker"],
  "memory-runtime": [
    "memory-api",
    "memory-cleanup",
    "memory-erasure",
    "memory-flush",
    "memory-index",
    "memory-index-dispatch",
    "memory-operation",
    "memory-operation-reconcile",
    "memory-reconcile",
    "memory-search-placement",
    "memory-shadow",
    "memory-usage",
  ],
  "ops-alerts-notifier": ["ops-alerts-notifier"],
  "platform-api": [
    "api",
    "api-administration",
    "api-brain",
    "api-budget",
    "api-evaluations",
    "api-governance",
    "api-observability",
    "api-system",
    "brain-content-maintenance",
    "brain-erasure-worker",
    "brain-index-dispatch",
    "brain-index-worker",
    "brain-search-erasure",
    "brain-search-placement",
    "brain-sync-dispatch",
    "brain-sync-worker",
    "e2e-callback",
    "e2e-mcp",
    "governance-worker",
  ],
} as const satisfies Record<DeploymentArtifactName, readonly string[]>;

export interface LambdaReleaseOptions {
  readonly allowMissing: boolean;
  readonly allowMissingAgentEmail: boolean;
  readonly allowMissingAgentObservability: boolean;
  readonly allowMissingAppDomains: boolean;
  readonly allowMissingAppsDatabase: boolean;
  readonly allowMissingConsole: boolean;
  readonly allowMissingEventAnalytics: boolean;
  readonly allowMissingIdentity: boolean;
}

function nestedString(outputs: TerraformOutputs, output: string, field: string) {
  const value = outputs[output];
  if (value === null || typeof value !== "object") return "";
  const nested: unknown = Reflect.get(value, field);
  return typeof nested === "string" ? nested : "";
}

/** Derives which unconfigured Lambda groups may be skipped from the applied root's outputs. */
export function lambdaReleaseOptions(
  outputs: TerraformOutputs,
  allowMissingLambdas: boolean,
): LambdaReleaseOptions {
  return {
    allowMissing: allowMissingLambdas,
    allowMissingAgentEmail:
      !nestedString(outputs, "agent_email", "api_function_arn") ||
      !nestedString(outputs, "agent_email", "inbound_function_arn"),
    allowMissingAgentObservability: !nestedString(
      outputs,
      "agent_observability",
      "fact_stream_arn",
    ),
    allowMissingAppDomains: !nestedString(
      outputs,
      "app_runtime",
      "domain_reconciler_function_name",
    ),
    allowMissingAppsDatabase: !nestedString(outputs, "app_runtime", "database_function_name"),
    allowMissingConsole: !consoleEndpoint(outputs),
    allowMissingEventAnalytics: !outputs.event_analytics_projector_function_arn,
    allowMissingIdentity: !nestedString(outputs, "platform_identity_function_arns", "api"),
  };
}

export function deployedLambdaFunctionName(artifact: DeploymentArtifactName, suffix: string) {
  if (artifact === "identity-api" || artifact === "identity-email-worker") {
    return `identity-${suffix}`;
  }
  return suffix;
}

const decodeDeployedFunctions = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      CodeSha256: Schema.String,
      FunctionName: Schema.String,
      Handler: Schema.NullOr(Schema.String),
      LastModified: Schema.String,
      Timeout: Schema.Number,
    }),
  ),
);

async function deployedFunctions(run: CommandRunner) {
  const output = await run([
    "aws",
    "lambda",
    "list-functions",
    "--query",
    "Functions[].{FunctionName:FunctionName,CodeSha256:CodeSha256,Handler:Handler,LastModified:LastModified,Timeout:Timeout}",
    "--output",
    "json",
  ]);
  return new Map(
    decodeDeployedFunctions(JSON.parse(output)).map((deployed) => {
      const lastModified = Date.parse(deployed.LastModified);
      if (Number.isNaN(lastModified)) {
        throw new Error(
          `Lambda ${deployed.FunctionName} reports an unreadable LastModified ${deployed.LastModified}.`,
        );
      }
      return [deployed.FunctionName, { ...deployed, LastModified: lastModified }] as const;
    }),
  );
}

/**
 * Lambda serves the replaced code until an update finishes, and `LastModified` records when the
 * update started. An update an earlier run made finished before that run's `function-updated-v2`
 * waiter returned, which polls 300 times a second apart; the extra minute covers the polls' own
 * request time.
 */
const EARLIER_UPDATE_FINISHED_WITHIN_MILLISECONDS = 360_000;

interface CodeArchive {
  readonly path: string;
  readonly sha256: string;
}

function functionArchives(release: VerifiedRelease, workDirectory: string) {
  const extracted = new Map<DeploymentArtifactName, readonly string[]>();
  const entryArchives = new Map<string, CodeArchive>();
  return async (
    artifact: DeploymentArtifactName,
    functionName: string,
    handler: string | null,
  ): Promise<CodeArchive> => {
    if (!("files" in deploymentArtifacts[artifact])) return release.artifacts[artifact];
    const source = join(workDirectory, "extracted", artifact);
    let files = extracted.get(artifact);
    if (!files) {
      await mkdir(source, { recursive: true });
      await runCommand(["unzip", "-q", release.artifacts[artifact].path, "-d", source]);
      files = await readdir(source);
      extracted.set(artifact, files);
    }
    const module = handler && /^(.+)\.[^.]+$/u.exec(handler)?.[1];
    const entry = files.find((file) => file !== "package.json" && parse(file).name === module);
    if (!entry) {
      throw new Error(
        `Lambda ${functionName} handler ${handler} names no module in the ${artifact} artifact.`,
      );
    }
    const key = `${artifact}/${entry}`;
    const cached = entryArchives.get(key);
    if (cached) return cached;
    const staging = join(workDirectory, "entries", artifact, parse(entry).name);
    await mkdir(staging, { recursive: true });
    for (const file of files.includes("package.json") ? [entry, "package.json"] : [entry]) {
      await link(join(source, file), join(staging, file));
    }
    const path = `${staging}.zip`;
    await createDeterministicZip(staging, path);
    const archive = { path, sha256: await sha256File(path) };
    entryArchives.set(key, archive);
    return archive;
  };
}

export interface ReleasedLambdaFunction {
  readonly artifact: DeploymentArtifactName;
  readonly codeSha256: string;
  readonly functionName: string;
}

export interface LambdaRelease {
  readonly functions: readonly ReleasedLambdaFunction[];
  /**
   * Epoch milliseconds by which every invocation of replaced code has ended: the latest, across
   * every released function, of its last code update's completion plus its timeout. Counts updates
   * an earlier run made, so a rerun after a run that published and then stopped still waits.
   */
  readonly replacedCodeEndsAt: number;
}

export async function deployLambdaRelease(
  input: LambdaReleaseOptions & {
    readonly dryRun: boolean;
    readonly name: string;
    readonly now: () => number;
    readonly release: VerifiedRelease;
    readonly run: CommandRunner;
  },
): Promise<LambdaRelease> {
  const deployed = await deployedFunctions(input.run);
  const workDirectory = await mkdtemp(join(tmpdir(), "lambda-release-"));
  try {
    const functionArchive = functionArchives(input.release, workDirectory);
    const released: ReleasedLambdaFunction[] = [];
    let replacedCodeEndsAt = 0;
    const changed: {
      readonly archivePath: string;
      readonly functionName: string;
      readonly timeoutSeconds: number;
    }[] = [];
    for (const [artifact, suffixes] of Object.entries(artifactFunctionSuffixes) as readonly [
      DeploymentArtifactName,
      readonly string[],
    ][]) {
      for (const suffix of suffixes) {
        const functionName = deployedLambdaFunctionName(artifact, suffix);
        const current = deployed.get(functionName);
        if (current === undefined) {
          if (
            input.allowMissing ||
            (artifact === "agent-email-runtime" && input.allowMissingAgentEmail) ||
            (artifact === "agent-runtime" &&
              input.allowMissingAgentObservability &&
              agentObservabilityFunctionSuffixes.has(suffix)) ||
            (artifact === "app-domains" && input.allowMissingAppDomains) ||
            (artifact === "apps-database" && input.allowMissingAppsDatabase) ||
            (artifact === "console" && input.allowMissingConsole) ||
            (artifact === "event-analytics-projector" && input.allowMissingEventAnalytics) ||
            ((artifact === "identity-api" || artifact === "identity-email-worker") &&
              input.allowMissingIdentity)
          ) {
            log(`lambda skipping unconfigured ${functionName}`);
            continue;
          }
          throw new Error(`Expected deployed Lambda ${functionName}.`);
        }

        const archive = await functionArchive(artifact, functionName, current.Handler);
        released.push({ artifact, codeSha256: archive.sha256, functionName });
        replacedCodeEndsAt = Math.max(
          replacedCodeEndsAt,
          current.LastModified +
            EARLIER_UPDATE_FINISHED_WITHIN_MILLISECONDS +
            current.Timeout * 1_000,
        );
        if (current.CodeSha256 === Buffer.from(archive.sha256, "hex").toString("base64")) {
          log(`lambda unchanged ${functionName}`);
          continue;
        }
        if (input.dryRun) {
          log(`lambda would publish ${functionName}`);
          continue;
        }
        changed.push({ archivePath: archive.path, functionName, timeoutSeconds: current.Timeout });
      }
    }

    let next = 0;
    let failed = false;
    const publish = async () => {
      while (!failed && next < changed.length) {
        const { archivePath, functionName, timeoutSeconds } = changed[next++]!;
        log(`lambda publishing ${functionName}`);
        try {
          await input.run([
            "aws",
            "lambda",
            "update-function-code",
            "--function-name",
            functionName,
            "--zip-file",
            `fileb://${archivePath}`,
            "--output",
            "json",
          ]);
          await input.run([
            "aws",
            "lambda",
            "wait",
            "function-updated-v2",
            "--function-name",
            functionName,
          ]);
          // Invocations that started before the update completed run the replaced code until
          // they return, at the latest when the function's timeout stops them.
          replacedCodeEndsAt = Math.max(replacedCodeEndsAt, input.now() + timeoutSeconds * 1_000);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    // A failure stops new publishes; in-flight ones finish before the first error is reported.
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(LAMBDA_PUBLISH_CONCURRENCY, changed.length) }, publish),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;

    if (released.length === 0) {
      throw new Error(`No platform Lambda functions are deployed in ${input.name}.`);
    }
    return { functions: released, replacedCodeEndsAt };
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
}
