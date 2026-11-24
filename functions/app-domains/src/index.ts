import { ACMClient } from "@aws-sdk/client-acm";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeAppPersistence,
  makeDynamoDatabase,
  makeIdGenerator,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { acmCertificates } from "./acm-certificates.ts";
import { cloudFrontEdge } from "./cloudfront-edge.ts";
import { createDomainReconcilerHandler, type DomainReconcilerHandler } from "./handler.ts";
import { makeDomainReconciler } from "./reconcile.ts";

export const APP_DOMAINS_ENV = {
  certificateRequestsPerDay: "APPS_DOMAIN_CERTIFICATE_REQUESTS_PER_DAY",
  certificateRequestsPerOrganizationPerDay:
    "APPS_DOMAIN_CERTIFICATE_REQUESTS_PER_ORGANIZATION_PER_DAY",
  connectionGroupId: "APPS_CUSTOM_DOMAIN_CONNECTION_GROUP_ID",
  distributionId: "APPS_CUSTOM_DOMAIN_DISTRIBUTION_ID",
} as const;

const Required = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

const DailyLimit = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
);

const Environment = Schema.Struct({
  [APP_DOMAINS_ENV.certificateRequestsPerDay]: DailyLimit,
  [APP_DOMAINS_ENV.certificateRequestsPerOrganizationPerDay]: DailyLimit,
  [APP_DOMAINS_ENV.connectionGroupId]: Required,
  [APP_DOMAINS_ENV.distributionId]: Required,
});

/** CloudFront is global, and CloudFront-managed certificates live in us-east-1. */
const EDGE_REGION = "us-east-1";

export function readConfiguration(variables: Readonly<Record<string, string | undefined>>) {
  const environment = Schema.decodeUnknownSync(Environment)(variables);
  return {
    certificateRequestLimits: {
      organization: environment[APP_DOMAINS_ENV.certificateRequestsPerOrganizationPerDay],
      platform: environment[APP_DOMAINS_ENV.certificateRequestsPerDay],
    },
    connectionGroupId: environment[APP_DOMAINS_ENV.connectionGroupId],
    distributionId: environment[APP_DOMAINS_ENV.distributionId],
  };
}

function createHandler() {
  const { certificateRequestLimits, connectionGroupId, distributionId } = readConfiguration(
    process.env,
  );
  const now = () => new Date();
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const log = (level: "error" | "info") => (entry: Readonly<Record<string, unknown>>) =>
    console[level](JSON.stringify({ level, ...entry }));
  return createDomainReconcilerHandler({
    emit: log("info"),
    now,
    reconciler: makeDomainReconciler({
      certificateRequestLimits,
      certificates: acmCertificates(new ACMClient({ region: EDGE_REGION })),
      domains: makeAppPersistence({
        database: makeDynamoDatabase(documentClient, tableNamesFromEnvironment(process.env)),
        generateId: makeIdGenerator().generate,
        now,
      }),
      edge: cloudFrontEdge({
        client: new CloudFrontClient({ region: EDGE_REGION }),
        connectionGroupId,
        distributionId,
      }),
      logError: log("error"),
      now,
    }),
  });
}

let domainReconcilerHandler: DomainReconcilerHandler | undefined;

export const handler = (event: unknown) => {
  domainReconcilerHandler ??= createHandler();
  return domainReconcilerHandler(event);
};
