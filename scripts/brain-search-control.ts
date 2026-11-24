import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { makeBrainSearchProviderRegistry } from "@deployments-ai/brain-runtime";
import {
  getBrainSearchPlacement,
  makeDynamoDatabase,
  makeIdGenerator,
  tableNamesFromEnvironment,
  Ulid,
  type BrainSearchTarget,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { parseArgs } from "node:util";
import { migrateBrainSearchPlacement } from "./brain-search-migration.ts";
import { invokeLambda } from "./platform-deploy/lambda-invoke.ts";
import { runCommand, runMain, type CommandRunner } from "./platform-deploy/process.ts";

// Organizations get their default Brain search placement automatically once memory search is
// active. `migrate` moves an active placement to the Brain OpenSearch domain named in the
// environment, for example after the domain was replaced. `drop-erased-index` drops the index of
// an organization whose erasure finished before erasure dropped Brain indexes.
const USAGE = [
  "Usage:",
  "  migrate <organizationId> <actorPrincipalId>",
  "  drop-erased-index <organizationId> [--index <name>] [--function-name <name>]",
].join("\n");

function argument(index: number, label: string) {
  const value = process.argv[index]?.trim();
  if (!value) throw new Error(`${label} is required.\n${USAGE}`);
  return value;
}

const DropOutcome = Schema.Struct({
  outcome: Schema.Literals(["already-absent", "dropped", "refused"]),
});

/**
 * Asks the in-VPC `brain-search-erasure` function to drop the Brain index that a completed erasure
 * left behind, with the operator's AWS credentials. A refusal exits 1.
 */
export async function dropErasedIndex(run: CommandRunner, args: readonly string[]) {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      "function-name": { default: "brain-search-erasure", type: "string" },
      index: { type: "string" },
    },
  });
  const [organizationId, ...extra] = positionals;
  if (!organizationId || extra.length > 0) {
    throw new TypeError(`Pass exactly one organizationId.\n${USAGE}`);
  }
  const organization = Schema.decodeUnknownSync(Ulid)(organizationId);
  const result = await invokeLambda(run, values["function-name"], {
    action: "drop-erased-organization-search-index",
    index: values.index ?? `brain-${organization.toLowerCase()}-v1`,
    organizationId: organization,
  });
  const { outcome } = Schema.decodeUnknownSync(DropOutcome)(result);
  return { exitCode: outcome === "refused" ? 1 : 0, result };
}

function environment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const command = argument(2, "command");
  if (command === "drop-erased-index") {
    const { exitCode, result } = await dropErasedIndex(runCommand, process.argv.slice(3));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCode;
    return;
  }
  if (command !== "migrate") throw new Error(USAGE);
  const organizationId = Schema.decodeUnknownSync(Ulid)(argument(3, "organization ID"));
  const actorPrincipalId = argument(4, "actor principal ID");
  const region = environment("AWS_REGION");
  const database = makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(process.env),
  );
  const ids = makeIdGenerator();
  const generateId = async () => ids.generate();
  const openSearchEndpoint = environment("DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT");
  const registry = makeBrainSearchProviderRegistry({
    config: { aws: { openSearchEndpoint } },
    database,
  });
  const current = await getBrainSearchPlacement(database, organizationId);
  const readTarget = current?.data.readTarget;
  if (!readTarget) throw new Error("Only an active Brain search placement can be migrated.");
  const target: BrainSearchTarget = {
    components: await Promise.all(
      (["dense", "entity", "exact", "lexical"] as const).map(async (kind) => ({
        componentId: await generateId(),
        kind,
      })),
    ),
    embeddingProfileId: readTarget.embeddingProfileId,
    location: {
      openSearchEndpoint,
      openSearchIndex: `brain-${organizationId.toLowerCase()}-v1`,
      region,
    },
    providerId: "aws-native",
    schemaGeneration: readTarget.schemaGeneration,
    targetId: await generateId(),
  };
  const result = await migrateBrainSearchPlacement({
    actorPrincipalId,
    database,
    generateId,
    now: () => new Date().toISOString(),
    organizationId,
    // Creates the target's physical index and requires every retrieval component to be ready,
    // so reads only move to a target that can serve them. Needs network access to the domain.
    prepare: async (candidate) => {
      const provider = await registry.resolve(candidate);
      await provider.prepare({ organizationId });
      const readiness = await provider.inspect({ organizationId });
      if (!readiness.ready || readiness.components.some((component) => !component.ready)) {
        throw new Error("Brain provider target did not become hybrid-ready.");
      }
    },
    target,
  });
  console.log(
    JSON.stringify({
      organizationId,
      outcome: result.outcome,
      providerId: result.target.providerId,
      targetId: result.target.targetId,
    }),
  );
}

if (import.meta.main) runMain(main);
