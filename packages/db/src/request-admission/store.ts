import {
  ConditionalCheckFailedException,
  DynamoDBServiceException,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  decideGcra,
  RequestRateStoreUnavailable,
  type GcraParameters,
  type RequestRateStore,
} from "@deployments-ai/tenant-limits";

const MAX_ATTEMPTS = 3;
const MAX_REMEMBERED_ORGANIZATIONS = 10_000;
const TTL_GRACE_SECONDS = 3_600;
const THROTTLING_ERRORS = new Set([
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "ThrottlingException",
]);

type Update = "busy" | "idle";

function expiresAt(theoreticalArrivalUs: number) {
  return String(Math.ceil(theoreticalArrivalUs / 1e6) + TTL_GRACE_SECONDS);
}

/** DynamoDB conditions cannot add, so the tolerance ceiling is precomputed. */
function updateCommand(input: {
  readonly key: string;
  readonly nowUs: number;
  readonly parameters: GcraParameters;
  readonly tableName: string;
  readonly update: Update;
}) {
  const { emissionIntervalUs, burstToleranceUs } = input.parameters;
  const ceilingUs = input.nowUs + burstToleranceUs;
  const common = {
    ExpressionAttributeNames: { "#tat": "tat", "#ttl": "ttl" },
    Key: { pk: { S: input.key } },
    ReturnValues: "UPDATED_NEW",
    ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    TableName: input.tableName,
  } as const;
  return input.update === "idle"
    ? new UpdateItemCommand({
        ...common,
        ConditionExpression: "attribute_not_exists(#pk) OR #tat < :now",
        ExpressionAttributeNames: { ...common.ExpressionAttributeNames, "#pk": "pk" },
        ExpressionAttributeValues: {
          ":next": { N: String(input.nowUs + emissionIntervalUs) },
          ":now": { N: String(input.nowUs) },
          ":ttl": { N: expiresAt(input.nowUs + emissionIntervalUs) },
        },
        UpdateExpression: "SET #tat = :next, #ttl = :ttl",
      })
    : new UpdateItemCommand({
        ...common,
        ConditionExpression: "#tat >= :now AND #tat <= :ceiling",
        ExpressionAttributeValues: {
          ":ceiling": { N: String(ceilingUs) },
          ":interval": { N: String(emissionIntervalUs) },
          ":now": { N: String(input.nowUs) },
          ":ttl": { N: expiresAt(ceilingUs + emissionIntervalUs) },
        },
        UpdateExpression: "SET #tat = #tat + :interval, #ttl = :ttl",
      });
}

function storedArrival(item: Record<string, AttributeValue> | undefined) {
  const value = item?.tat?.N;
  return value === undefined ? undefined : Number(value);
}

function unavailable(cause: unknown) {
  if (!(cause instanceof Error)) return undefined;
  const status =
    cause instanceof DynamoDBServiceException ? cause.$metadata.httpStatusCode : undefined;
  if (
    cause.name === "AbortError" ||
    cause.name === "TimeoutError" ||
    THROTTLING_ERRORS.has(cause.name) ||
    (status !== undefined && status >= 500)
  ) {
    return new RequestRateStoreUnavailable(`The request-admission table failed: ${cause.name}.`, {
      cause,
    });
  }
  return undefined;
}

export function makeRequestAdmissionStore(input: {
  readonly client: DynamoDBClient;
  readonly requestTimeoutMs?: number;
  readonly tableName: string;
}): RequestRateStore {
  const requestTimeoutMs = input.requestTimeoutMs ?? 150;
  const knownArrivals = new Map<string, number>();

  const remember = (organizationId: string, theoreticalArrivalUs: number) => {
    knownArrivals.delete(organizationId);
    knownArrivals.set(organizationId, theoreticalArrivalUs);
    if (knownArrivals.size > MAX_REMEMBERED_ORGANIZATIONS) {
      const oldest = knownArrivals.keys().next().value;
      if (oldest !== undefined) knownArrivals.delete(oldest);
    }
  };

  return {
    consume: async (organizationId, parameters, nowUs) => {
      const abortSignal = AbortSignal.timeout(requestTimeoutMs);
      const key = `ORG#${organizationId}`;
      let update: Update = (knownArrivals.get(organizationId) ?? 0) >= nowUs ? "busy" : "idle";
      for (let attempt = 1; ; attempt += 1) {
        let observedUs: number | undefined;
        try {
          const output = await input.client.send(
            updateCommand({ key, nowUs, parameters, tableName: input.tableName, update }),
            { abortSignal },
          );
          const theoreticalArrivalUs = storedArrival(output.Attributes);
          if (theoreticalArrivalUs !== undefined) remember(organizationId, theoreticalArrivalUs);
          return { kind: "admitted" };
        } catch (cause) {
          if (!(cause instanceof ConditionalCheckFailedException)) {
            throw unavailable(cause) ?? cause;
          }
          observedUs = storedArrival(cause.Item);
        }
        if (observedUs !== undefined) remember(organizationId, observedUs);
        const decision = decideGcra(observedUs, parameters, nowUs);
        if (decision.kind === "rejected") return decision;
        if (attempt === MAX_ATTEMPTS) {
          throw new RequestRateStoreUnavailable(
            `The request-admission write lost ${MAX_ATTEMPTS} consecutive races.`,
          );
        }
        update = observedUs !== undefined && observedUs >= nowUs ? "busy" : "idle";
      }
    },
  };
}
