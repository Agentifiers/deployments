import { isRecord, stringValue } from "./types.ts";

const PROVIDER_ERROR_MESSAGE_MAX_CHARACTERS = 512;

function chatCompletionProviderError(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  if (isRecord(body.error)) return body.error;
  const extraFields = isRecord(body.extra_fields) ? body.extra_fields : undefined;
  const rawResponse = isRecord(extraFields?.raw_response) ? extraFields.raw_response : undefined;
  return isRecord(rawResponse?.error) ? rawResponse.error : undefined;
}

function boundedProviderErrorMessage(value: unknown): string | undefined {
  const message = stringValue(value);
  if (!message) return undefined;
  const normalized = message
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, PROVIDER_ERROR_MESSAGE_MAX_CHARACTERS) : undefined;
}

export function chatCompletionProviderErrorDiagnostic(body: unknown) {
  const error = chatCompletionProviderError(body);
  const response = isRecord(body) ? body : undefined;
  const code = stringValue(error?.code ?? error?.type ?? response?.type);
  const message = boundedProviderErrorMessage(error?.message);
  return { code, error, message };
}

export function providerErrorMessageSuffix(code: string | undefined, message: string | undefined) {
  return `${code ? ` (${code})` : ""}${message ? ` Provider message: ${message}` : ""}`;
}
