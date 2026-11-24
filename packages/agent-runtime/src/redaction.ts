const SENSITIVE_ASSIGNMENT_NAME = String.raw`(?:[a-z0-9]+[-_])*(?:secret[-_]?access[-_]?key|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|security[-_]?token|access[-_]?token|refresh[-_]?token|authorization|credential|password|passwd|secret|token|key)`;
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`["']?\b(${SENSITIVE_ASSIGNMENT_NAME})\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Basic|Bearer)\s+[^\s,;]+|[^\r\n,;]+)`,
  "giu",
);
const AUTH_SCHEME_CREDENTIAL = /\b(?:Basic|Bearer)\s+[^\s,;]+/giu;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/?#:]+):([^\s/?#]*)@/giu;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu;
const PROVIDER_TOKEN =
  /\b(?:sk-(?:(?:proj|svcacct)-|ant-[a-z0-9-]*-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk)_live_[A-Za-z0-9]{16,})\b/gu;
const PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu;
const UNTERMINATED_PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/gu;
const UNTERMINATED_URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/?#:]+):([^\s/?#]*)$/giu;
/** Matches only a quoted value that is still open at the end of a bounded prefix. */
const UNTERMINATED_SECRET_ASSIGNMENT = new RegExp(
  String.raw`["']?\b(${SENSITIVE_ASSIGNMENT_NAME})\b["']?\s*[:=]\s*(?:"(?:\\[\s\S]|[^"\\])*\\?|'(?:\\[\s\S]|[^'\\])*\\?)$`,
  "giu",
);

export function redactRuntimeSensitiveText(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, "[redacted-private-key]")
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .replace(AUTH_SCHEME_CREDENTIAL, "[redacted-auth]")
    .replace(SECRET_ASSIGNMENT, "$1=[redacted]")
    .replace(AWS_ACCESS_KEY, "[redacted-aws-access-key]")
    .replace(PROVIDER_TOKEN, "[redacted-provider-token]");
}

export function redactRuntimeSensitivePrefix(value: string): string {
  const withoutTruncatedUrlCredentials = value.replace(
    UNTERMINATED_URL_CREDENTIALS,
    (match, scheme: string, authority: string, secret: string) => {
      const port = /^\d{1,5}$/u.test(secret) ? Number(secret) : Number.NaN;
      const unambiguousHost =
        authority === "localhost" || authority.includes(".") || authority.startsWith("[");
      return unambiguousHost && Number.isInteger(port) && port <= 65_535
        ? match
        : `${scheme}[redacted]`;
    },
  );
  return redactRuntimeSensitiveText(
    withoutTruncatedUrlCredentials
      .replace(UNTERMINATED_SECRET_ASSIGNMENT, "$1=[redacted]")
      .replace(UNTERMINATED_PRIVATE_KEY_BLOCK, "[redacted-private-key]"),
  );
}

export function boundedRuntimeError(cause: unknown, fallback: string): string {
  // Non-error objects have no meaningful text; use the fallback instead of "[object Object]".
  const raw =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string" || typeof cause === "number" || typeof cause === "boolean"
        ? String(cause)
        : "";
  const redacted = Array.from(redactRuntimeSensitivePrefix(raw || fallback), (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  })
    .join("")
    .trim();
  if (redacted.length <= 1_000) return redacted || fallback;
  return `${redacted.slice(0, 997)}...`;
}
