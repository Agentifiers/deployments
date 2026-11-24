import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeDynamoDatabase,
  resumeBrainErasure,
  tableNamesFromEnvironment,
  Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { runMain } from "./platform-deploy/process.ts";

const USAGE = ["Usage:", "  resume <organizationId> <brainId> <erasureId>"].join("\n");

function ulidArgument(index: number, label: string) {
  const value = process.argv[index]?.trim();
  if (!value) throw new Error(`${label} is required.\n${USAGE}`);
  return Schema.decodeUnknownSync(Ulid)(value);
}

async function main() {
  if (process.argv[2] !== "resume") throw new Error(USAGE);
  const organizationId = ulidArgument(3, "organization ID");
  const brainId = ulidArgument(4, "Brain ID");
  const erasureId = ulidArgument(5, "erasure ID");
  const erasure = await resumeBrainErasure(
    makeDynamoDatabase(
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      }),
      tableNamesFromEnvironment(process.env),
    ),
    { brainId, erasureId, now: new Date().toISOString(), organizationId },
  );
  console.info(
    JSON.stringify({
      error: erasure.error,
      id: erasure.id,
      nextDueAt: erasure.nextDueAt,
      phase: erasure.phase,
      status: erasure.status,
    }),
  );
}

if (import.meta.main) runMain(main);
