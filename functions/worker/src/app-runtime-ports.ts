import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  AppsDatabaseResponse,
  type AppsDatabaseRequest,
} from "@deployments-ai/app-database/protocol";
import { makeAppPersistence, PROVISION_INVOCATION_ATTEMPTS } from "@deployments-ai/db";
import { Option, Schema } from "effect";
import { Buffer } from "node:buffer";
import type { AppRuntimeServices } from "./app-runtime-tools.ts";
import { AppToolRefusal } from "./app-tool-refusal.ts";
import { appsRuntimeConfig } from "./worker-env.ts";

export type InvokeAppsDatabase = <Request extends AppsDatabaseRequest>(
  request: Request,
) => Promise<AppsDatabaseResponse<Request["op"]>>;

export interface AppReleaseObject {
  readonly byteSize: number;
  readonly cacheControl: string | undefined;
  readonly contentType: string;
  readonly key: string;
  readonly sha256: string;
}

export interface StoredAppReleaseObject {
  readonly byteSize: number;
  readonly sha256: string | undefined;
}

export interface AppReleaseObjects {
  readonly presignCreate: (object: AppReleaseObject) => Promise<{
    readonly headers: Readonly<Record<string, string>>;
    readonly url: string;
  }>;
  readonly head: (key: string, signal?: AbortSignal) => Promise<StoredAppReleaseObject | undefined>;
}

const decodeFunctionError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ errorType: Schema.String })),
);

export function createLambdaAppsDatabase(options: {
  readonly client: Pick<LambdaClient, "send">;
  readonly functionName: string;
}): InvokeAppsDatabase {
  return async <Request extends AppsDatabaseRequest>(request: Request) => {
    const response = await options.client.send(
      new InvokeCommand({
        FunctionName: options.functionName,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify(request)),
      }),
    );
    const payload = new TextDecoder().decode(response.Payload);
    const envelope = response.FunctionError
      ? Option.none()
      : Schema.decodeUnknownOption(Schema.fromJsonString(AppsDatabaseResponse[request.op]))(
          payload,
        );
    if (Option.isSome(envelope)) return envelope.value;
    console.error("The apps-database function did not answer.", {
      errorType: response.FunctionError
        ? (Option.getOrUndefined(decodeFunctionError(payload))?.errorType ?? response.FunctionError)
        : "InvalidResponse",
      functionName: options.functionName,
      requestId: response.$metadata.requestId,
    });
    throw new AppToolRefusal(
      "apps_database_unavailable",
      "The app database did not answer. Call this tool again with the same input in a minute; if it keeps failing, tell the user the app database is unavailable.",
    );
  };
}

/** S3 checks presigned expiry when a request starts, so this bounds start time only. */
const PRESIGNED_UPLOAD_TTL_SECONDS = 900;

export function createS3AppReleaseObjects(options: {
  readonly bucket: string;
  readonly client: S3Client;
}): AppReleaseObjects {
  const { bucket, client } = options;
  return {
    head: async (key, signal) => {
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, ChecksumMode: "ENABLED", Key: key }),
          signal ? { abortSignal: signal } : {},
        );
        return {
          byteSize: head.ContentLength ?? 0,
          sha256: head.ChecksumSHA256
            ? Buffer.from(head.ChecksumSHA256, "base64").toString("hex")
            : undefined,
        };
      } catch (cause) {
        if (cause instanceof Error && cause.name === "NotFound") return undefined;
        throw cause;
      }
    },
    presignCreate: async (object) => {
      const checksum = Buffer.from(object.sha256, "hex").toString("base64");
      const headers: Readonly<Record<string, string>> = {
        ...(object.cacheControl ? { "cache-control": object.cacheControl } : {}),
        "content-type": object.contentType,
        "if-none-match": "*",
        "x-amz-checksum-sha256": checksum,
      };
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          ...(object.cacheControl ? { CacheControl: object.cacheControl } : {}),
          ChecksumSHA256: checksum,
          ContentType: object.contentType,
          IfNoneMatch: "*",
          Key: object.key,
        }),
        {
          expiresIn: PRESIGNED_UPLOAD_TTL_SECONDS,
          // Signed as headers (not hoisted into the query) so S3 enforces each one.
          signableHeaders: new Set(Object.keys(headers)),
          unhoistableHeaders: new Set(
            Object.keys(headers).filter((name) => name.startsWith("x-amz-")),
          ),
        },
      );
      return { headers, url };
    },
  };
}

export function appBuiltinOptions(
  env: Readonly<Record<string, string | undefined>>,
  dependencies: Pick<Parameters<typeof makeAppPersistence>[0], "database" | "generateId"> & {
    readonly s3: S3Client;
  },
): { readonly apps?: AppRuntimeServices } {
  const config = appsRuntimeConfig(env);
  if (!config) return {};
  return {
    apps: {
      apps: makeAppPersistence({
        database: dependencies.database,
        generateId: dependencies.generateId,
        now: () => new Date(),
      }),
      database: createLambdaAppsDatabase({
        client: new LambdaClient({ maxAttempts: PROVISION_INVOCATION_ATTEMPTS }),
        functionName: config.databaseFunctionName,
      }),
      domain: config.domain,
      now: () => new Date(),
      objects: createS3AppReleaseObjects({ bucket: config.bucket, client: dependencies.s3 }),
    },
  };
}
