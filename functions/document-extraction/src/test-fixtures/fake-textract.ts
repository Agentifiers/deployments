import { Schema } from "effect";
import { pdfPages } from "./pdf-pages.ts";

export type FakeTextractAnswer =
  | { readonly lines: readonly string[] }
  | { readonly error: string; readonly status: number };

const json = (status: number, body: object) =>
  Response.json(body, { status, headers: { "content-type": "application/x-amz-json-1.1" } });
const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({ Document: Schema.Struct({ Bytes: Schema.String }) }),
);

export function fakeTextract(answersByPageWidth: Readonly<Record<number, FakeTextractAnswer>>) {
  const requests: number[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("x-amz-target") !== "Textract.DetectDocumentText") {
        return json(400, { __type: "UnknownOperationException" });
      }
      const body = decodeRequest(await request.json());
      const pages = await pdfPages(Buffer.from(body.Document.Bytes, "base64"));
      const [page] = pages;
      requests.push(page?.width ?? 0);
      const answer = pages.length === 1 && page ? answersByPageWidth[page.width] : undefined;
      if (answer === undefined) {
        return json(400, {
          __type: "UnsupportedDocumentException",
          message: "Request has unsupported document format",
        });
      }
      if ("error" in answer) return json(answer.status, { __type: answer.error, message: "fake" });
      return json(200, {
        Blocks: [
          { BlockType: "PAGE" },
          ...answer.lines.flatMap((Text) => [
            { BlockType: "LINE", Text },
            { BlockType: "WORD", Text: Text.split(" ")[0] },
          ]),
        ],
        DocumentMetadata: { Pages: 1 },
      });
    },
  });
  return { url: server.url.origin, requests, stop: () => server.stop(true) };
}
