import type { CliCommand } from "./cli-tree.ts";
import type { JsonSchema, OpenApiOperation } from "./openapi-types.ts";
import type { DocumentedOperation } from "./operations.ts";
import { isSchema } from "./schema-normalization.ts";
import { slugify } from "./urls.ts";

export const API_BASE_URL = "https://api.example.com";
export const SDK_PACKAGE = "@agentifiers/deployments-sdk";

const MAX_EXAMPLE_DEPTH = 5;

function placeholder(name: string): string {
  return `<${slugify(name)}>`;
}

function schemaList(value: unknown): readonly JsonSchema[] {
  return Array.isArray(value) ? value.filter(isSchema) : [];
}

function minimumItems(schema: JsonSchema): number {
  const own = typeof schema.minItems === "number" ? schema.minItems : 0;
  return Math.max(own, ...schemaList(schema.allOf).map(minimumItems));
}

function exampleValue(
  schema: JsonSchema,
  name: string,
  schemas: Readonly<Record<string, JsonSchema>>,
  depth: number,
): unknown {
  if (typeof schema.$ref === "string") {
    const referenced = schemas[schema.$ref.replace("#/components/schemas/", "")];
    return referenced ? exampleValue(referenced, name, schemas, depth) : {};
  }
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const variants = [...schemaList(schema.anyOf), ...schemaList(schema.oneOf)].filter(
    (variant) => variant.type !== "null",
  );
  const [firstVariant] = variants;
  if (firstVariant && schema.type === undefined) {
    return exampleValue(firstVariant, name, schemas, depth);
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  if (type === "object" || isSchema(schema.properties)) {
    if (depth >= MAX_EXAMPLE_DEPTH) return {};
    const properties = isSchema(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    return Object.fromEntries(
      required.flatMap((property) => {
        const propertySchema = properties[property];
        return isSchema(propertySchema)
          ? [[property, exampleValue(propertySchema, property, schemas, depth + 1)]]
          : [];
      }),
    );
  }
  if (type === "array") {
    if (minimumItems(schema) === 0 || !isSchema(schema.items)) return [];
    return [exampleValue(schema.items, name, schemas, depth + 1)];
  }
  if (type === "integer" || type === "number") {
    return typeof schema.minimum === "number" ? Math.max(schema.minimum, 1) : 1;
  }
  if (type === "boolean") return true;
  if (schema.format === "date-time") return "2026-01-01T00:00:00.000Z";
  if (schema.format === "uri" || schema.format === "url") return "https://example.com";
  return placeholder(name);
}

function nestedObjectLiteral(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replaceAll(/^(\s*)"([A-Za-z_$][\w$]*)":/gmu, "$1$2:")
    .replaceAll("\n", "\n  ");
}

function headerValue(name: string): string {
  if (name === "idempotency-key") return "crypto.randomUUID()";
  return JSON.stringify(
    placeholder(name.startsWith("x-deployments-") ? `${name.slice(14)}-id` : name),
  );
}

function clientConfig(operation: DocumentedOperation): string {
  const authentication = operation.route.authentication;
  switch (authentication) {
    case "none":
      return `createConfig({ baseUrl: "${API_BASE_URL}" })`;
    case "stream-session":
      return [
        "createConfig({",
        '    baseUrl: "<stream-gateway-origin>",',
        '    headers: { authorization: "Bearer <stream-session-token>" },',
        "  })",
      ].join("\n");
    case "tenant-jwt":
      return [
        "createConfig({",
        `    baseUrl: "${API_BASE_URL}",`,
        "    headers: { authorization: `Bearer ${process.env.DEPLOYMENTS_TENANT_JWT}` },",
        "  })",
      ].join("\n");
    case "api-credential-or-platform-bearer":
    case "platform-bearer":
      return [
        "createConfig({",
        `    baseUrl: "${API_BASE_URL}",`,
        "    headers: { authorization: `Bearer ${process.env.DEPLOYMENTS_API_KEY}` },",
        "  })",
      ].join("\n");
    default: {
      const exhaustive: never = authentication;
      return exhaustive;
    }
  }
}

export function sdkSample(
  operation: DocumentedOperation,
  openapiOperation: OpenApiOperation,
  schemas: Readonly<Record<string, JsonSchema>>,
): string {
  const parameters = openapiOperation.parameters ?? [];
  const valuesIn = (location: "header" | "path" | "query") =>
    parameters.filter((parameter) => parameter.in === location && parameter.required === true);
  const options: string[] = ["client"];
  const pathParameters = valuesIn("path");
  if (pathParameters.length > 0) {
    options.push(
      `path: { ${pathParameters.map((parameter) => `${parameter.name}: ${JSON.stringify(exampleValue(parameter.schema ?? {}, parameter.name, schemas, 0))}`).join(", ")} }`,
    );
  }
  const queryParameters = valuesIn("query");
  if (queryParameters.length > 0) {
    const query = Object.fromEntries(
      queryParameters.map((parameter) => [
        parameter.name,
        exampleValue(parameter.schema ?? {}, parameter.name, schemas, 0),
      ]),
    );
    options.push(`query: ${nestedObjectLiteral(query)}`);
  }
  const headers = valuesIn("header");
  if (headers.length > 0) {
    options.push(
      [
        "headers: {",
        ...headers.map((parameter) => `    "${parameter.name}": ${headerValue(parameter.name)},`),
        "  }",
      ].join("\n"),
    );
  }
  const bodySchema = openapiOperation.requestBody?.content["application/json"]?.schema;
  if (bodySchema) {
    options.push(`body: ${nestedObjectLiteral(exampleValue(bodySchema, "body", schemas, 0))}`);
  }
  const name = operation.route.name;
  return [
    `import { createClient, createConfig, ${name} } from "${SDK_PACKAGE}";`,
    "",
    "const client = createClient(",
    `  ${clientConfig(operation)},`,
    ");",
    "",
    `const { data, error } = await ${name}({`,
    ...options.map((option) => `  ${option},`),
    "});",
    "",
  ].join("\n");
}

export function cliExample(command: CliCommand): string {
  return [
    command.command,
    ...command.arguments.flatMap((argument) => {
      if (!argument.required) return [];
      if (argument.kind === "positional") return [placeholder(argument.name)];
      if (argument.kind === "boolean") return [`--${argument.name}`];
      const [firstOption] = argument.options ?? [];
      return [
        `--${argument.name}`,
        firstOption ?? placeholder(argument.valueHint ?? argument.name),
      ];
    }),
  ].join(" ");
}

export function cliSample(operation: DocumentedOperation): string {
  return `${[...new Set(operation.cli.map(cliExample))].join("\n")}\n`;
}
