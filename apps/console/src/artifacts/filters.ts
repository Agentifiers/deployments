/** The environment artifacts list's filters, kept in the URL and sent to `GET /v1/artifacts`. */
export interface ArtifactFilters {
  readonly contentType?: string;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
  readonly runId?: string;
  readonly threadId?: string;
  readonly type?: string;
}

export const CONTENT_TYPE_FILTERS = [
  { label: "Images", value: "image/*" },
  { label: "Text", value: "text/*" },
  { label: "JSON", value: "application/json" },
  { label: "PDF", value: "application/pdf" },
  { label: "Audio", value: "audio/*" },
  { label: "Video", value: "video/*" },
] as const;

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MEDIA_TYPE = /^[\w!#$&^_.+-]+\/(?:\*|[\w!#$&^_.+-]+)$/u;
const MAX_TYPE_CHARACTERS = 100;

function ulid(value: unknown) {
  return typeof value === "string" && ULID.test(value) ? value : undefined;
}

function instant(value: unknown) {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : undefined;
}

function artifactType(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && Array.from(trimmed).length <= MAX_TYPE_CHARACTERS ? trimmed : undefined;
}

export function parseArtifactFilters(search: Readonly<Record<string, unknown>>): ArtifactFilters {
  const contentType =
    typeof search.contentType === "string" && MEDIA_TYPE.test(search.contentType)
      ? search.contentType.toLowerCase()
      : undefined;
  const createdAfter = instant(search.createdAfter);
  const createdBefore = instant(search.createdBefore);
  const runId = ulid(search.runId);
  const threadId = ulid(search.threadId);
  const type = artifactType(search.type);
  return {
    ...(contentType ? { contentType } : {}),
    ...(createdAfter ? { createdAfter } : {}),
    ...(createdBefore && (!createdAfter || createdBefore >= createdAfter) ? { createdBefore } : {}),
    ...(runId ? { runId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(type ? { type } : {}),
  };
}

export function hasArtifactFilters(filters: ArtifactFilters) {
  return Object.keys(filters).length > 0;
}
