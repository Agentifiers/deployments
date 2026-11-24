import { StreamContractError } from "./errors.ts";

export const THREAD_STREAM_PATH_PREFIX = "/v1/stream" as const;

export interface ThreadStreamScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly threadId: string;
}

function segment(field: keyof ThreadStreamScope, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new StreamContractError(field, `${field} is required.`);
  if (normalized === "." || normalized === "..") {
    throw new StreamContractError(field, `${field} must not be a dot path segment.`);
  }
  return encodeURIComponent(normalized);
}

export function threadStreamPath(scope: ThreadStreamScope): string {
  return [
    THREAD_STREAM_PATH_PREFIX,
    "org",
    segment("organizationId", scope.organizationId),
    "project",
    segment("projectId", scope.projectId),
    "environment",
    segment("environmentId", scope.environmentId),
    "thread",
    segment("threadId", scope.threadId),
  ].join("/");
}

function decodedSegment(field: keyof ThreadStreamScope, value: string | undefined): string {
  if (!value) throw new StreamContractError(field, `Thread stream path is missing ${field}.`);
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded === "." || decoded === "..") throw new Error("invalid segment");
    return decoded;
  } catch {
    throw new StreamContractError(field, `Thread stream path has invalid ${field}.`);
  }
}

export function parseThreadStreamPath(path: string): ThreadStreamScope {
  if (path.includes("?") || path.includes("#") || /^[a-z][a-z\d+.-]*:/iu.test(path)) {
    throw new StreamContractError(
      "path",
      "Thread stream path must be a relative path without query or fragment.",
    );
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const parts = normalized.split("/");
  if (
    parts.length !== 11 ||
    parts[1] !== "v1" ||
    parts[2] !== "stream" ||
    parts[3] !== "org" ||
    parts[5] !== "project" ||
    parts[7] !== "environment" ||
    parts[9] !== "thread"
  ) {
    throw new StreamContractError(
      "path",
      "Thread stream path does not match the platform thread stream layout.",
    );
  }
  return {
    organizationId: decodedSegment("organizationId", parts[4]),
    projectId: decodedSegment("projectId", parts[6]),
    environmentId: decodedSegment("environmentId", parts[8]),
    threadId: decodedSegment("threadId", parts[10]),
  };
}

export function sameThreadStreamScope(left: ThreadStreamScope, right: ThreadStreamScope): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId
  );
}
