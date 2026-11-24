import { CloudFrontKeyValueStoreClient } from "@aws-sdk/client-cloudfront-keyvaluestore";
import { S3Client } from "@aws-sdk/client-s3";
import { createAppDatabaseControl, rdsConnectionSettings } from "@deployments-ai/app-database";
import { Schema } from "effect";
import { createAppsDatabaseHandler, type AppsDatabaseHandler } from "./handler.ts";
import { awsKeyValueStoreApi, keyValueStoreSlugDirectory } from "./key-value-store.ts";
import { s3AppObjectStore } from "./s3-app-object-store.ts";

const Required = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

const Environment = Schema.Struct({
  APPS_BUCKET: Required,
  APPS_DATABASE_HOST: Required,
  APPS_DATABASE_PORT: Schema.String.pipe(Schema.check(Schema.isPattern(/^[1-9][0-9]{0,4}$/u))),
  APPS_DATABASE_REGION: Required,
  APPS_KEY_VALUE_STORE_ARN: Required,
});

/** Rides out an Aurora resume, about 15 to 30 s, and leaves most of the 300 s function timeout. */
const DATABASE_RESUME_WAIT_MS = 60_000;

function createHandler() {
  const environment = Schema.decodeUnknownSync(Environment)(process.env);
  const connections = rdsConnectionSettings({
    host: environment.APPS_DATABASE_HOST,
    port: Number(environment.APPS_DATABASE_PORT),
    region: environment.APPS_DATABASE_REGION,
    resumeWaitMs: DATABASE_RESUME_WAIT_MS,
  });
  const slugDirectory = keyValueStoreSlugDirectory(
    awsKeyValueStoreApi(
      new CloudFrontKeyValueStoreClient({}),
      environment.APPS_KEY_VALUE_STORE_ARN,
    ),
  );
  const objectStore = s3AppObjectStore(new S3Client({}));
  return createAppsDatabaseHandler({
    bucket: environment.APPS_BUCKET,
    logError: (entry) => console.error(JSON.stringify({ level: "error", ...entry })),
    openControl: () => createAppDatabaseControl({ connections, objectStore, slugDirectory }),
  });
}

let appsDatabaseHandler: AppsDatabaseHandler | undefined;

export const handler = (event: unknown) => {
  appsDatabaseHandler ??= createHandler();
  return appsDatabaseHandler(event);
};
