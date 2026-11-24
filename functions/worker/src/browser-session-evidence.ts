import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  BROWSER_SESSION_EXECUTE_TOOL_NAME,
  MAX_BROWSER_SESSION_RESPONSE_BYTES,
  browserSessionExecutionResponse,
  decodeBrowserSessionExecutionResult,
  type BrowserSessionExecutionResult,
  type NormalizedBrowserSessionExecuteInput,
} from "@deployments-ai/browser-screenshot";
import { createHash } from "node:crypto";

/** Covered by the artifact bucket's 30-day `browser-session-idempotency/` lifecycle rule. */
const BROWSER_SESSION_EVIDENCE_PREFIX = "browser-session-idempotency/";

export interface BrowserSessionEvidenceIdentity {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly idempotencyKey: string;
  readonly input: NormalizedBrowserSessionExecuteInput;
  readonly runId: string;
}

export interface BrowserSessionEvidenceStore {
  /** Loads the stored evidence; a missing object or a mismatched fingerprint throws. */
  readonly load: (
    identity: BrowserSessionEvidenceIdentity,
    signal?: AbortSignal,
  ) => Promise<BrowserSessionExecutionResult>;
  /**
   * Stores evidence create-only and returns the durable copy: when an earlier attempt already
   * stored evidence for the same identity and input, that copy wins.
   */
  readonly store: (
    identity: BrowserSessionEvidenceIdentity,
    result: BrowserSessionExecutionResult,
    signal?: AbortSignal,
  ) => Promise<BrowserSessionExecutionResult>;
}

function browserSessionEvidenceKey(identity: BrowserSessionEvidenceIdentity) {
  const digest = createHash("sha256")
    .update(`${BROWSER_SESSION_EXECUTE_TOOL_NAME}\0${identity.runId}\0${identity.idempotencyKey}`)
    .digest("hex");
  return `${BROWSER_SESSION_EVIDENCE_PREFIX}${digest}`;
}

function fingerprint(input: NormalizedBrowserSessionExecuteInput) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function isMissingObject(cause: unknown) {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as {
    readonly $metadata?: { readonly httpStatusCode?: number };
    readonly name?: string;
  };
  return error.$metadata?.httpStatusCode === 404 || error.name === "NoSuchKey";
}

export function createS3BrowserSessionEvidenceStore(options: {
  readonly bucket: string;
  readonly client: Pick<S3Client, "send">;
  readonly kmsKeyId: string;
}): BrowserSessionEvidenceStore {
  const read = async (
    identity: BrowserSessionEvidenceIdentity,
    signal: AbortSignal | undefined,
  ): Promise<BrowserSessionExecutionResult | undefined> => {
    let response;
    try {
      response = await options.client.send(
        new GetObjectCommand({
          Bucket: options.bucket,
          ChecksumMode: "ENABLED",
          Key: browserSessionEvidenceKey(identity),
        }),
        signal ? { abortSignal: signal } : undefined,
      );
    } catch (cause) {
      if (isMissingObject(cause)) return undefined;
      throw cause;
    }
    if (response.Metadata?.fingerprint !== fingerprint(identity.input)) {
      await response.Body?.transformToByteArray().catch(() => undefined);
      throw new Error("Stored browser session evidence belongs to a different session input.");
    }
    if (
      response.ContentLength === undefined ||
      response.ContentLength <= 0 ||
      response.ContentLength > MAX_BROWSER_SESSION_RESPONSE_BYTES ||
      !response.Body
    ) {
      throw new Error("Stored browser session evidence has an invalid size.");
    }
    const bytes = await response.Body.transformToByteArray();
    if (
      bytes.byteLength !== response.ContentLength ||
      createHash("sha256").update(bytes).digest("hex") !== response.Metadata.sha256
    ) {
      throw new Error("Stored browser session evidence failed its checksum.");
    }
    try {
      return decodeBrowserSessionExecutionResult(JSON.parse(new TextDecoder().decode(bytes)), {
        actions: identity.input.actions,
        allowedOrigins: identity.allowedOrigins,
      });
    } catch (cause) {
      throw new Error("Stored browser session evidence is invalid.", { cause });
    }
  };

  return {
    load: async (identity, signal) => {
      const stored = await read(identity, signal);
      if (!stored) throw new Error("Stored browser session evidence was not found.");
      return stored;
    },
    store: async (identity, result, signal) => {
      const bytes = new TextEncoder().encode(
        JSON.stringify(browserSessionExecutionResponse(result)),
      );
      if (bytes.byteLength > MAX_BROWSER_SESSION_RESPONSE_BYTES) {
        throw new Error("Browser session evidence exceeds its storage limit.");
      }
      const digest = createHash("sha256").update(bytes).digest();
      try {
        await options.client.send(
          new PutObjectCommand({
            Body: bytes,
            Bucket: options.bucket,
            ChecksumSHA256: digest.toString("base64"),
            ContentLength: bytes.byteLength,
            ContentType: "application/json",
            IfNoneMatch: "*",
            Key: browserSessionEvidenceKey(identity),
            Metadata: { fingerprint: fingerprint(identity.input), sha256: digest.toString("hex") },
            ServerSideEncryption: "aws:kms",
            SSEKMSKeyId: options.kmsKeyId,
          }),
          signal ? { abortSignal: signal } : undefined,
        );
        return result;
      } catch (cause) {
        // An earlier attempt may have stored this session, or the write may have landed.
        const stored = await read(identity, signal);
        if (stored) return stored;
        throw new Error("Browser session evidence could not be stored.", { cause });
      }
    },
  };
}
