import "@tanstack/react-start/server-only";
import { PUBLIC_API_SCHEMAS, type PublicApiSchemaName } from "@deployments-ai/api-contract";
import { Schema, SchemaIssue } from "effect";
import { PlatformApiError } from "../errors.ts";

type SchemaType<Name extends PublicApiSchemaName> = (typeof PUBLIC_API_SCHEMAS)[Name]["Type"];

const issueList = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Names the fields the contract rejects. The schema's own messages quote the rejected value, and
 * a request body can carry a client secret or a credential.
 */
function rejectedFields(cause: unknown): string {
  if (!Schema.isSchemaError(cause)) {
    return "The request does not match the operation's contract.";
  }
  const paths = issueList(cause.issue).issues.map(
    ({ path }) =>
      (path ?? [])
        .map((segment) => String(typeof segment === "object" ? segment.key : segment))
        .join(".") || "the request body",
  );
  return `The request has an invalid value at ${[...new Set(paths)].join(", ")}.`;
}

/**
 * Decodes an untrusted request body against its contract schema. A body the contract rejects
 * fails here as a 400 problem that names the invalid fields without their values.
 */
export function decodeRequestBody<Name extends PublicApiSchemaName>(
  operation: string,
  name: Name,
  body: unknown,
): SchemaType<Name> {
  const decode = Schema.decodeUnknownSync(PUBLIC_API_SCHEMAS[name]);
  try {
    return decode(body);
  } catch (cause) {
    throw new PlatformApiError(operation, {
      detail: rejectedFields(cause),
      status: 400,
      title: "Invalid request",
    });
  }
}
