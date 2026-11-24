import type { LoaderPlugin } from "fumadocs-core/source";

export function apiMethodBadges(): LoaderPlugin {
  return {
    name: "docs:api-method-badges",
    transformPageTree: {
      file(node, filePath) {
        const file = filePath ? this.storage.read(filePath) : undefined;
        if (file?.format !== "page") return node;
        const openapi: unknown = "_openapi" in file.data ? file.data._openapi : undefined;
        const method =
          typeof openapi === "object" && openapi !== null && "method" in openapi
            ? openapi.method
            : undefined;
        if (typeof method !== "string") return node;
        return {
          ...node,
          name: (
            <>
              {node.name}{" "}
              <span className={`api-method api-method-${method.toLowerCase()}`}>{method}</span>
            </>
          ),
        };
      },
    },
  };
}
