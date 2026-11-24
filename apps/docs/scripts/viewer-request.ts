import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { DOCS_APP_DIRECTORY } from "./reference/urls.ts";

const DOCS_SITE_MODULE = join(
  DOCS_APP_DIRECTORY,
  "..",
  "..",
  "infrastructure",
  "modules",
  "docs-site",
  "main.tf",
);
const FUNCTION_RESOURCE = 'resource "aws_cloudfront_function" "directory_index" {';
const HEREDOC_START = "<<-JS\n";
const HEREDOC_END = "\n  JS\n";

/** Runs the docs site's viewer-request CloudFront function on a request for `uri`. */
export function loadViewerRequestHandler(): (uri: string) => unknown {
  const source = readFileSync(DOCS_SITE_MODULE, "utf8");
  const resource = source.indexOf(FUNCTION_RESOURCE);
  const start = resource === -1 ? -1 : source.indexOf(HEREDOC_START, resource);
  const end = start === -1 ? -1 : source.indexOf(HEREDOC_END, start);
  if (end === -1) {
    throw new Error(`${DOCS_SITE_MODULE} has no directory_index CloudFront function code.`);
  }
  const handler: unknown = runInNewContext(
    `${source.slice(start + HEREDOC_START.length, end)}\nhandler;`,
  );
  if (typeof handler !== "function") {
    throw new Error(
      `The directory_index CloudFront function in ${DOCS_SITE_MODULE} has no handler.`,
    );
  }
  return (uri) => handler({ request: { uri } });
}

export function loadViewerRequestRewrite(): (uri: string) => string {
  const handle = loadViewerRequestHandler();
  return (uri) => {
    const request = handle(uri);
    if (
      typeof request !== "object" ||
      request === null ||
      !("uri" in request) ||
      typeof request.uri !== "string"
    ) {
      throw new Error(`The directory_index CloudFront function returned no URI for ${uri}.`);
    }
    return request.uri;
  };
}
