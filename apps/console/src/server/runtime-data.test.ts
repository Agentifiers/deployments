import { MessageResponse } from "@deployments-ai/api-contract/runtime";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { transcriptMessage } from "./runtime-data.ts";

const message = (fields: Readonly<Record<string, unknown>>) =>
  Schema.decodeUnknownSync(MessageResponse)({
    contentHash: "ab12",
    createdAt: "2026-10-07T12:00:00.000Z",
    environmentId: "01K0000000000000000000000C",
    id: "01K0000000000000000000000M",
    object: "message",
    organizationId: "01K0000000000000000000000A",
    projectId: "01K0000000000000000000000B",
    role: "user",
    sequence: 3,
    threadId: "01K0000000000000000000000T",
    ...fields,
  });

describe("transcriptMessage", () => {
  test("counts the files attached to a message", () => {
    expect(
      transcriptMessage(
        message({
          body: "What does this error say?",
          inputArtifacts: ["01K0000000000000000000000X", "01K0000000000000000000000Y"],
          runId: "01K0000000000000000000000R",
        }),
      ),
    ).toEqual({
      attachedFileCount: 2,
      content: { kind: "text", text: "What does this error say?" },
      createdAt: "2026-10-07T12:00:00.000Z",
      id: "01K0000000000000000000000M",
      role: "user",
      runId: "01K0000000000000000000000R",
      sequence: 3,
    });
    expect(transcriptMessage(message({ body: "Thanks." })).attachedFileCount).toBe(0);
  });
});
