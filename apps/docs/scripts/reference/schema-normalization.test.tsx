import { expect, test } from "bun:test";
import type { Document } from "fumadocs-openapi";
import { renderToString } from "react-dom/server";
import { OpenAPIPage } from "../../components/api-page.tsx";
import { normalizeComponentSchemas } from "./schema-normalization.ts";

const JSON_VALUE = "#/components/schemas/JsonValue";

test("the API page renders an array of a self-referencing JSON value", () => {
  const document: Document = {
    openapi: "3.2.0",
    info: { title: "Values", version: "1.0.0" },
    paths: {
      "/values": {
        get: {
          operationId: "listValues",
          responses: {
            "200": {
              description: "Values",
              content: {
                "application/json": { schema: { type: "array", items: { $ref: JSON_VALUE } } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: normalizeComponentSchemas({
        JsonValue: {
          anyOf: [
            { type: "null" },
            { type: "boolean" },
            { type: "number" },
            { type: "string" },
            { type: "array", items: { $ref: JSON_VALUE } },
            { type: "object", additionalProperties: { $ref: JSON_VALUE } },
          ],
        },
      }),
    },
  };

  const html = renderToString(
    <OpenAPIPage
      payload={{ bundled: document }}
      operations={[{ path: "/values", method: "get" }]}
    />,
  );

  expect(html.replaceAll(/<[^>]*>/gu, "")).toContain(
    "null|boolean|number|string|array&lt;unknown&gt;|object",
  );
});
