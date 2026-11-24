import {
  BadDocumentException,
  DetectDocumentTextCommand,
  DocumentTooLargeException,
  TextractClient,
  UnsupportedDocumentException,
} from "@aws-sdk/client-textract";
import type { NonEmpty, PageRecognition, ScannedPage } from "./engine/pdf-text.ts";
import { LIMITS } from "./limits.ts";

const TEXTRACT_ENDPOINT_VARIABLE = "DEPLOYMENTS_AI_TEXTRACT_ENDPOINT";

export interface TextractOcr {
  readonly kind: "textract";
  recognize(scans: NonEmpty<ScannedPage>, signal: AbortSignal): Promise<readonly PageRecognition[]>;
}

export type Ocr = { readonly kind: "off" } | TextractOcr;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function parseEndpoint(value: string): URL {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (
    url?.protocol === "https:" ||
    (url?.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    return url;
  }
  throw new Error(
    `${TEXTRACT_ENDPOINT_VARIABLE} must be an absolute https URL, or http for a loopback host.`,
  );
}

async function recognizePage(
  client: TextractClient,
  { pageNumber, pdf }: ScannedPage,
  abortSignal: AbortSignal,
): Promise<PageRecognition> {
  try {
    const { Blocks = [] } = await client.send(
      new DetectDocumentTextCommand({ Document: { Bytes: pdf } }),
      { abortSignal },
    );
    const lines = Blocks.flatMap((block) =>
      block.BlockType === "LINE" && block.Text !== undefined
        ? [block.Text.replaceAll(/[\f\r]/gu, " ")]
        : [],
    );
    return { pageNumber, result: "text", text: lines.join("\n") };
  } catch (error) {
    if (
      error instanceof UnsupportedDocumentException ||
      error instanceof BadDocumentException ||
      error instanceof DocumentTooLargeException
    ) {
      return { pageNumber, result: "rejected" };
    }
    throw error;
  }
}

async function recognize(
  client: TextractClient,
  scans: NonEmpty<ScannedPage>,
  signal: AbortSignal,
): Promise<readonly PageRecognition[]> {
  const stop = new AbortController();
  const abortSignal = AbortSignal.any([signal, stop.signal]);
  const recognized: PageRecognition[] = [];
  const pageMs: number[] = [];
  const pending = scans.entries();
  const work = async () => {
    for (const [index, scan] of pending) {
      const started = performance.now();
      recognized[index] = await recognizePage(client, scan, abortSignal);
      pageMs[index] = Math.round(performance.now() - started);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(LIMITS.ocr.concurrency, scans.length) }, work));
  } catch (cause) {
    stop.abort();
    throw new Error("Textract could not read the scanned PDF pages.", { cause });
  }
  console.info("Read scanned PDF pages with Textract.", {
    pageMs,
    pages: scans.length,
    rejected: recognized.filter(({ result }) => result === "rejected").length,
  });
  return recognized;
}

export function ocrFromEnvironment(env: NodeJS.ProcessEnv): Ocr {
  const endpoint = env[TEXTRACT_ENDPOINT_VARIABLE];
  if (endpoint === undefined) return { kind: "off" };
  const client = new TextractClient({ endpoint: parseEndpoint(endpoint).href, maxAttempts: 3 });
  return {
    kind: "textract",
    recognize: (scans, signal) => recognize(client, scans, signal),
  };
}
