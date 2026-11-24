import { PlatformApiError } from "../errors.ts";

/** The API's limit on one artifact upload, and on a file a run reads as input. */
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const MAX_INPUT_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const INPUT_ARTIFACT_TYPE = "input";

/** The signed request `createArtifactUpload` returns for the browser to send the bytes. */
export interface UploadTarget {
  readonly expiresAt: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

export type UploadProblem =
  | { readonly kind: "empty" }
  | { readonly kind: "too-large"; readonly limit: number }
  | { readonly kind: "expired" }
  | { readonly kind: "hash-mismatch" }
  | { readonly kind: "network" }
  | { readonly kind: "rejected"; readonly message: string };

/**
 * One upload, in order: hash the file, create the upload, send the bytes, then ask the platform
 * to verify them. A failure keeps the artifact ID once the platform created one, so the user can
 * find the pending artifact, which expires on its own.
 */
export type UploadState =
  | { readonly kind: "hashing" }
  | { readonly kind: "creating" }
  | {
      readonly artifactId: string;
      readonly kind: "sending";
      readonly sent: number;
      readonly total: number;
    }
  | { readonly artifactId: string; readonly kind: "completing" }
  | { readonly artifactId: string; readonly kind: "done" }
  | { readonly artifactId?: string; readonly kind: "failed"; readonly problem: UploadProblem };

/** What the storage service answered to the PUT; `status` 0 means no response arrived. */
export interface PutResult {
  readonly body: string;
  readonly status: number;
}

export interface UploadPorts {
  readonly complete: (artifactId: string) => Promise<unknown>;
  readonly create: (sha256: string) => Promise<{
    readonly artifactId: string;
    readonly upload: UploadTarget;
  }>;
  readonly now: () => number;
  readonly put: (target: UploadTarget, onProgress: (sent: number) => void) => Promise<PutResult>;
  readonly sha256: () => Promise<string>;
}

export function fileProblem(size: number, limit: number): UploadProblem | undefined {
  if (size === 0) return { kind: "empty" };
  return size > limit ? { kind: "too-large", limit } : undefined;
}

/**
 * Reads an S3 error response. An expired signature answers 403 `AccessDenied` "Request has
 * expired"; bytes that do not match the signed checksum answer 400 `BadDigest`. A 412 means an
 * earlier attempt already stored this object, so the upload goes on to verification.
 */
export function putOutcome(result: PutResult): "stored" | UploadProblem {
  if (result.status >= 200 && result.status < 300) return "stored";
  if (result.status === 412) return "stored";
  if (result.status === 0) return { kind: "network" };
  const code = /<Code>([^<]+)<\/Code>/u.exec(result.body)?.[1];
  if (/request has expired/iu.test(result.body) || code === "ExpiredToken")
    return { kind: "expired" };
  if (code === "BadDigest" || code === "InvalidDigest" || /checksum/iu.test(result.body)) {
    return { kind: "hash-mismatch" };
  }
  return {
    kind: "rejected",
    message: `The storage service refused the file (${code ?? `status ${result.status}`}).`,
  };
}

function platformProblem(error: unknown): UploadProblem {
  if (error instanceof PlatformApiError) {
    if (error.problem.code === "artifact_upload_mismatch") return { kind: "hash-mismatch" };
    if (error.problem.code === "input_file_too_large") {
      return { kind: "too-large", limit: MAX_INPUT_ARTIFACT_BYTES };
    }
    if (error.problem.code === "invalid_artifact_size") {
      return { kind: "too-large", limit: MAX_ARTIFACT_BYTES };
    }
    return { kind: "rejected", message: error.message };
  }
  if (error instanceof TypeError) return { kind: "network" };
  return { kind: "rejected", message: error instanceof Error ? error.message : String(error) };
}

export async function runUpload(
  size: number,
  limit: number,
  ports: UploadPorts,
  onState: (state: UploadState) => void,
): Promise<UploadState> {
  const settle = (state: UploadState) => {
    onState(state);
    return state;
  };
  const refused = fileProblem(size, limit);
  if (refused) return settle({ kind: "failed", problem: refused });
  let artifactId: string | undefined;
  const failed = (problem: UploadProblem) =>
    settle({ ...(artifactId ? { artifactId } : {}), kind: "failed", problem });
  try {
    onState({ kind: "hashing" });
    const sha256 = await ports.sha256();
    onState({ kind: "creating" });
    const created = await ports.create(sha256);
    artifactId = created.artifactId;
    const id = artifactId;
    if (Date.parse(created.upload.expiresAt) <= ports.now()) return failed({ kind: "expired" });
    onState({ artifactId: id, kind: "sending", sent: 0, total: size });
    const outcome = putOutcome(
      await ports.put(created.upload, (sent) =>
        onState({ artifactId: id, kind: "sending", sent: Math.min(sent, size), total: size }),
      ),
    );
    if (outcome !== "stored") return failed(outcome);
    onState({ artifactId: id, kind: "completing" });
    await ports.complete(id);
    return settle({ artifactId: id, kind: "done" });
  } catch (error) {
    return failed(platformProblem(error));
  }
}

const MIB = 1024 * 1024;

export function uploadProblemText(problem: UploadProblem): string {
  switch (problem.kind) {
    case "empty":
      return "The file is empty.";
    case "too-large":
      return `The file is larger than ${problem.limit / MIB} MiB.`;
    case "expired":
      return "The upload link expired before the file arrived. Upload the file again.";
    case "hash-mismatch":
      return "The stored bytes do not match the file's SHA-256 digest. The file may have changed while it was read. Upload it again.";
    case "network":
      return "The connection failed while sending the file. Check the network and upload it again.";
    case "rejected":
      return problem.message;
  }
}

/** Lowercase hex SHA-256 of the file, computed in the browser. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Browsers set `content-length` themselves and refuse a script that sets it. */
const BROWSER_SET_HEADERS = new Set(["content-length"]);

/** Sends the file with XMLHttpRequest, which reports upload progress where fetch does not. */
export function xhrPut(file: Blob): UploadPorts["put"] {
  return (target, onProgress) =>
    new Promise((resolve) => {
      const request = new XMLHttpRequest();
      request.open("PUT", target.url);
      for (const [name, value] of Object.entries(target.headers)) {
        if (!BROWSER_SET_HEADERS.has(name.toLowerCase())) request.setRequestHeader(name, value);
      }
      request.upload.addEventListener("progress", (event) => onProgress(event.loaded));
      request.addEventListener("load", () =>
        resolve({ body: request.responseText, status: request.status }),
      );
      request.addEventListener("error", () => resolve({ body: "", status: 0 }));
      request.addEventListener("abort", () => resolve({ body: "", status: 0 }));
      request.send(file);
    });
}
