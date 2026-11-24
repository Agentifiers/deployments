import { FederationError, type FederationErrorCode } from "./errors.ts";

export interface FederationHttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface FederationHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

export type FederationHttp = (request: FederationHttpRequest) => Promise<FederationHttpResponse>;

export type JsonObject = Readonly<Record<string, unknown>>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export async function requestText(input: {
  readonly http: FederationHttp;
  readonly request: FederationHttpRequest;
  readonly failure: FederationErrorCode;
}): Promise<string> {
  const response = await input.http(input.request);
  if (response.status !== 200) throw new FederationError(input.failure);
  return response.body;
}

export async function requestJsonObject(input: {
  readonly http: FederationHttp;
  readonly request: FederationHttpRequest;
  readonly failure: FederationErrorCode;
}): Promise<JsonObject> {
  const document = parseJson(await requestText(input));
  if (!isJsonObject(document)) throw new FederationError(input.failure);
  return document;
}
