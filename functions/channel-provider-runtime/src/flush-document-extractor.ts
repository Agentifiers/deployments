import { LambdaClient } from "@aws-sdk/client-lambda";
import { makeLambdaFileTextExtractor, type FileTextExtractor } from "@deployments-ai/file-text";

const DOCUMENT_EXTRACTION_FUNCTION_NAME_ENV = "DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME";

let extractor: FileTextExtractor | undefined;

/**
 * Both ingress consumer Lambdas run this handler, but only the flush captures attachments, so
 * only the flush carries the function name and the invoke grant. Reading it on first use keeps
 * the other consumer from failing to start without it.
 */
export const flushDocumentExtractor: FileTextExtractor = {
  extract(request, signal) {
    if (!extractor) {
      const functionName = process.env[DOCUMENT_EXTRACTION_FUNCTION_NAME_ENV]?.trim();
      if (!functionName) throw new Error(`${DOCUMENT_EXTRACTION_FUNCTION_NAME_ENV} is required.`);
      extractor = makeLambdaFileTextExtractor({ functionName, lambda: new LambdaClient({}) });
    }
    return extractor.extract(request, signal);
  },
};
