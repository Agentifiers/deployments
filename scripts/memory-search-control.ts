import { makeIdGenerator, Ulid } from "@deployments-ai/db";
import { makeMemorySearchControlPlane, type MemorySearchTarget } from "@deployments-ai/memory";
import {
  currentMemoryMembershipDigest,
  decodeMemoryMembershipKeyring,
  memoryMembershipDigests,
  runtimeDatabase,
  runtimeMemorySearchRegistry,
  runtimeProvisioningEvidenceEmbedding,
} from "@deployments-ai/memory-runtime";
import { Schema } from "effect";
import { parseArgs } from "node:util";
import { invokeLambda } from "./platform-deploy/lambda-invoke.ts";
import { runCommand, runMain, type CommandRunner } from "./platform-deploy/process.ts";

function requiredArgument(index: number, name: string) {
  const value = process.argv[index]?.trim();
  if (!value) throw new TypeError(`${name} is required.`);
  return value;
}

async function jsonFile(path: string) {
  return JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
}

const DropOutcome = Schema.Struct({
  outcome: Schema.Literals(["already-dropped", "dropped", "nothing-to-drop", "refused"]),
});

/**
 * Asks the in-VPC `memory-erasure` function to drop a suspended organization's own memory search
 * indexes with the operator's AWS credentials. A refusal exits 1.
 */
export async function dropDisabledIndex(run: CommandRunner, args: readonly string[]) {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { "function-name": { default: "memory-erasure", type: "string" } },
  });
  const [organizationId] = positionals;
  if (!organizationId) throw new TypeError("organizationId is required.");
  const result = await invokeLambda(run, values["function-name"], {
    action: "drop-disabled-organization-search-index",
    organizationId: Schema.decodeUnknownSync(Ulid)(organizationId),
  });
  const { outcome } = Schema.decodeUnknownSync(DropOutcome)(result);
  return { exitCode: outcome === "refused" ? 1 : 0, result };
}

const RetireOutcome = Schema.Struct({ outcome: Schema.Literals(["refused", "retired"]) });

/**
 * Asks the in-VPC `memory-erasure` function to drop the memory index that a completed erasure left
 * behind and retire the catalog records that existed only for it. A refusal exits 1.
 */
export async function retireErasedIndex(run: CommandRunner, args: readonly string[]) {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      "function-name": { default: "memory-erasure", type: "string" },
      index: { type: "string" },
    },
  });
  const [organizationId, ...extra] = positionals;
  if (!organizationId || extra.length > 0) throw new TypeError("Pass exactly one organizationId.");
  const organization = Schema.decodeUnknownSync(Ulid)(organizationId);
  const result = await invokeLambda(run, values["function-name"], {
    action: "retire-erased-organization-search-index",
    index: values.index ?? `memory-${organization.toLowerCase()}-v1`,
    organizationId: organization,
  });
  const { outcome } = Schema.decodeUnknownSync(RetireOutcome)(result);
  return { exitCode: outcome === "refused" ? 1 : 0, result };
}

async function main() {
  const command = requiredArgument(2, "command");
  const operatorCommand =
    command === "drop-disabled-index"
      ? dropDisabledIndex
      : command === "retire-erased-index"
        ? retireErasedIndex
        : undefined;
  if (operatorCommand) {
    const { exitCode, result } = await operatorCommand(runCommand, process.argv.slice(3));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCode;
    return;
  }
  const membershipKeyringSecret = process.env.DEPLOYMENTS_AI_MEMORY_MEMBERSHIP_KEYRING?.trim();
  if (!membershipKeyringSecret) {
    throw new TypeError("DEPLOYMENTS_AI_MEMORY_MEMBERSHIP_KEYRING is required.");
  }
  const membershipKeyring = decodeMemoryMembershipKeyring(membershipKeyringSecret);

  const idGenerator = makeIdGenerator();
  const database = runtimeDatabase();
  const control = makeMemorySearchControlPlane({
    database,
    embedProvisioningEvidence: runtimeProvisioningEvidenceEmbedding,
    generateId: async () => idGenerator.generate(),
    membershipDigest: async (targetId) =>
      currentMemoryMembershipDigest(membershipKeyring, targetId),
    membershipDigests: async (targetId) => memoryMembershipDigests(membershipKeyring, targetId),
    registry: runtimeMemorySearchRegistry(database),
  });
  const organizationId = (value: string) => Schema.decodeUnknownSync(Ulid)(value);
  let result: unknown;
  switch (command) {
    case "abort-provisioning": {
      result = await control.abortProvisioning(
        organizationId(requiredArgument(3, "organizationId")),
      );
      break;
    }
    case "catalog": {
      result = await control.registerCatalog(
        (await jsonFile(requiredArgument(3, "catalog JSON path"))) as never,
      );
      break;
    }
    case "complete-migration": {
      result = await control.completeMigration(
        organizationId(requiredArgument(3, "organizationId")),
        organizationId(requiredArgument(4, "operationId")),
      );
      break;
    }
    case "provision": {
      const provisionedOrganizationId = organizationId(requiredArgument(3, "organizationId"));
      const input = await jsonFile(requiredArgument(4, "provisioning JSON path"));
      result = await control.requestProvisioning({
        evidenceKeys: input.evidenceKeys as string[],
        organizationId: provisionedOrganizationId,
        target: input.target as MemorySearchTarget,
      });
      break;
    }
    case "prepare": {
      result = await control.prepareProvisioning(
        organizationId(requiredArgument(3, "organizationId")),
        organizationId(requiredArgument(4, "operationId")),
        Number(requiredArgument(5, "actionGeneration")),
      );
      break;
    }
    default:
      throw new TypeError(`Unknown memory search control command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) runMain(main);
