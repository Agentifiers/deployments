import { Option, Schema } from "effect";

export interface HttpApiV2Event {
  readonly body?: string | null;
  readonly cookies?: readonly string[];
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly isBase64Encoded?: boolean;
  readonly rawPath: string;
  readonly rawQueryString?: string;
  readonly requestContext: {
    readonly authorizer?: unknown;
    readonly domainName?: string;
    readonly http: { readonly method: string };
    readonly requestId?: string;
  };
}

export interface HttpApiV2Result {
  readonly body: string;
  readonly cookies?: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly isBase64Encoded: false;
  readonly statusCode: number;
}

function requestHeaders(event: HttpApiV2Event) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  if (event.cookies?.length && !headers.has("cookie")) {
    headers.set("cookie", event.cookies.join("; "));
  }
  return headers;
}

const decodeIamAuthorizer = Schema.decodeUnknownOption(
  Schema.Struct({ iam: Schema.Struct({ userArn: Schema.String }) }),
);

const iamUserArns = new WeakMap<Request, string>();

/**
 * The caller API Gateway verified with SigV4 for a request this adapter built, present only on
 * routes with `authorization_type = "AWS_IAM"`. Bearer credentials are never reflected here.
 */
export function httpApiV2IamUserArn(request: Request): string | undefined {
  return iamUserArns.get(request);
}

export function requestFromHttpApiV2Event(event: HttpApiV2Event) {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const origin = event.requestContext.domainName ?? "api.us.deployments.ai";
  const method = event.requestContext.http.method.toUpperCase();
  const body =
    event.body === undefined || event.body === null
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;
  const request = new Request(`https://${origin}${event.rawPath}${query}`, {
    method,
    headers: requestHeaders(event),
    ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
  });
  const authorizer = decodeIamAuthorizer(event.requestContext.authorizer);
  if (Option.isSome(authorizer)) iamUserArns.set(request, authorizer.value.iam.userArn);
  return request;
}

export function createHttpApiV2Handler(fetchHandler: (request: Request) => Promise<Response>) {
  return async (event: HttpApiV2Event): Promise<HttpApiV2Result> => {
    const response = await fetchHandler(requestFromHttpApiV2Event(event));
    const headers: Record<string, string> = {};
    for (const [name, value] of response.headers) {
      if (name !== "set-cookie") headers[name] = value;
    }
    const cookies = response.headers.getSetCookie();
    return {
      body: await response.text(),
      ...(cookies.length ? { cookies } : {}),
      headers,
      isBase64Encoded: false,
      statusCode: response.status,
    };
  };
}
