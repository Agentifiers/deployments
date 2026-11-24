import { makePublicOpenApiSpec } from "@deployments-ai/api-contract/openapi";
import type { OpenApiDocument, OpenApiOperation } from "./openapi-types.ts";
import type { DocumentedOperation } from "./operations.ts";
import { API_BASE_URL, cliSample, sdkSample } from "./samples.ts";
import { isSchema, normalizeComponentSchemas, normalizeSchema } from "./schema-normalization.ts";

function isOpenApiDocument(value: unknown): value is OpenApiDocument {
  return (
    isSchema(value) &&
    typeof value.openapi === "string" &&
    isSchema(value.paths) &&
    Object.values(value.paths).every(
      (pathItem) =>
        isSchema(pathItem) &&
        Object.values(pathItem).every(
          (operation) => isSchema(operation) && typeof operation.operationId === "string",
        ),
    ) &&
    isSchema(value.components) &&
    isSchema(value.components.schemas) &&
    Object.values(value.components.schemas).every(isSchema)
  );
}

function normalizeOperation(operation: OpenApiOperation): OpenApiOperation {
  const { parameters, requestBody } = operation;
  return {
    ...operation,
    ...(parameters
      ? {
          parameters: parameters.map((parameter) =>
            parameter.schema
              ? { ...parameter, schema: normalizeSchema(parameter.schema) }
              : parameter,
          ),
        }
      : {}),
    ...(requestBody
      ? {
          requestBody: {
            ...requestBody,
            content: Object.fromEntries(
              Object.entries(requestBody.content).map(([mediaType, media]) => [
                mediaType,
                { ...media, schema: normalizeSchema(media.schema) },
              ]),
            ),
          },
        }
      : {}),
  };
}

export function buildDocsOpenApi(operations: readonly DocumentedOperation[]): OpenApiDocument {
  const spec: unknown = structuredClone(makePublicOpenApiSpec());
  if (!isOpenApiDocument(spec)) throw new Error("Public OpenAPI spec is not an OpenAPI document.");
  const schemas = normalizeComponentSchemas(spec.components.schemas);
  const operationsByName = new Map(
    operations.map((operation) => [operation.route.name, operation]),
  );
  const documentedNames = new Set<string>();
  const paths = Object.fromEntries(
    Object.entries(spec.paths).map(([path, pathItem]) => [
      path,
      Object.fromEntries(
        Object.entries(pathItem).map(([method, contractOperation]): [string, OpenApiOperation] => {
          const documented = operationsByName.get(contractOperation.operationId);
          if (!documented) {
            throw new Error(
              `OpenAPI operation ${contractOperation.operationId} is not a public API route.`,
            );
          }
          documentedNames.add(contractOperation.operationId);
          const operation = normalizeOperation(contractOperation);
          return [
            method,
            {
              ...operation,
              summary: documented.summary,
              "x-codeSamples": [
                {
                  lang: "ts",
                  label: "TypeScript SDK",
                  source: sdkSample(documented, operation, schemas),
                },
                { lang: "bash", label: "CLI", source: cliSample(documented) },
              ],
            },
          ];
        }),
      ),
    ]),
  );
  if (documentedNames.size !== operations.length) {
    throw new Error(
      `OpenAPI document has ${documentedNames.size} operations; PUBLIC_API_ROUTES has ${operations.length}.`,
    );
  }
  return {
    ...spec,
    servers: [{ url: API_BASE_URL }],
    paths,
    components: { ...spec.components, schemas },
  };
}
