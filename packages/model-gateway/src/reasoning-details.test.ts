import { describe, expect, test as it } from "bun:test";
import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { makeModelGateway, type ReasoningDetail } from "./index.ts";
import { isRecord } from "./types.ts";

const gateway = makeModelGateway({
  baseUrl: "https://bifrost.internal",
  credentials: async () => "gateway-token",
});

async function completion(response: () => Response) {
  return await Effect.runPromise(
    gateway.chatCompletion({
      fetch: (async () => response()) as unknown as typeof fetch,
      messages: [{ content: "Plan the tool calls.", role: "user" }],
      modelId: "openrouter/anthropic/claude-opus-5.5",
    }),
  );
}

async function fixture(name: string) {
  return await readFile(new URL(`./fixtures/reasoning/${name}`, import.meta.url), "utf8");
}

async function streamedCompletion(name: string) {
  const sse = await fixture(name);
  return await completion(
    () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
  );
}

async function streamedReasoning(name: string) {
  let reasoning = "";
  for (const line of (await fixture(name)).split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const event: unknown = JSON.parse(line.slice("data: ".length));
    const choice = isRecord(event) && Array.isArray(event.choices) ? event.choices[0] : undefined;
    const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined;
    if (typeof delta?.reasoning === "string") reasoning += delta.reasoning;
  }
  return reasoning;
}

async function referenceFieldsByType(references: readonly string[], omitted: readonly string[]) {
  const fields = new Map<string, string[]>();
  for (const reference of references) {
    const json: unknown = JSON.parse(await fixture(reference));
    for (const detail of (await completion(() => Response.json(json))).reasoningDetails ?? []) {
      if (fields.has(detail.type)) continue;
      fields.set(
        detail.type,
        Object.keys(detail)
          .filter((field) => !omitted.includes(field))
          .toSorted(),
      );
    }
  }
  return fields;
}

function joinedText(details: readonly ReasoningDetail[] | undefined) {
  return (details ?? [])
    .map(({ summary, text }) =>
      typeof text === "string" ? text : typeof summary === "string" ? summary : "",
    )
    .join("");
}

const CLAUDE = ["nonstream__anthropic__claude-haiku-5.5.json"];
const CLAUDE_OPUS = ["nonstream__anthropic__claude-opus-5.5.json"];
const GEMINI = [
  "nonstream__google__gemini-3.6-flash.json",
  "nonstream__google__gemini-3.6-flash__2.json",
];
const GPT_5 = ["nonstream__openai__gpt-5-nano.json"];

const FIXTURES: {
  readonly blocks: [type: string, index: number][];
  readonly references: readonly string[];
  readonly sse: string;
}[] = [
  {
    blocks: [["reasoning.text", 0]],
    references: CLAUDE,
    sse: "bifrost__anthropic__claude-haiku-5.5.sse",
  },
  {
    blocks: [["reasoning.text", 0]],
    references: CLAUDE,
    sse: "bifrost__anthropic__claude-haiku-5.5__multi.sse",
  },
  {
    blocks: [["reasoning.text", 0]],
    references: CLAUDE_OPUS,
    sse: "bifrost__anthropic__claude-opus-5.5.sse",
  },
  {
    blocks: [
      ["reasoning.text", 0],
      ["reasoning.encrypted", 0],
    ],
    references: GEMINI,
    sse: "bifrost__google__gemini-3.6-flash.sse",
  },
  {
    blocks: [
      ["reasoning.summary", 0],
      ["reasoning.encrypted", 1],
    ],
    references: GPT_5,
    sse: "bifrost__openai__gpt-5-nano.sse",
  },
  {
    blocks: [["reasoning.text", 0]],
    references: CLAUDE,
    sse: "openrouter-direct__anthropic__claude-haiku-5.5.sse",
  },
  {
    blocks: [
      ["reasoning.text", 0],
      ["reasoning.encrypted", 0],
    ],
    references: GEMINI,
    sse: "openrouter-direct__google__gemini-3.6-flash.sse",
  },
  {
    blocks: [["reasoning.encrypted", 0]],
    references: GEMINI,
    sse: "openrouter-direct__google__gemini-3.6-flash__parallel.sse",
  },
  {
    blocks: [
      ["reasoning.summary", 0],
      ["reasoning.encrypted", 1],
    ],
    references: GPT_5,
    sse: "openrouter-direct__openai__gpt-5-nano.sse",
  },
];

describe("streamed reasoning details", () => {
  it.each(FIXTURES)(
    "merges $sse into the blocks a non-streamed response carries",
    async ({ blocks, references, sse }) => {
      const omitted = sse.startsWith("bifrost__") ? ["format"] : [];
      const referenceFields = await referenceFieldsByType(references, omitted);

      const { reasoningDetails } = await streamedCompletion(sse);

      expect(reasoningDetails?.map(({ index, type }) => [type, index])).toEqual(blocks);
      expect(reasoningDetails?.map((detail) => Object.keys(detail).toSorted())).toEqual(
        blocks.map(([type]) => referenceFields.get(type) ?? []),
      );
      expect(joinedText(reasoningDetails)).toBe(await streamedReasoning(sse));
    },
  );

  it("folds Claude thinking into one signed text block", async () => {
    const result = await streamedCompletion("bifrost__anthropic__claude-opus-5.5.sse");

    expect(result.reasoningDetails).toEqual([
      {
        index: 0,
        signature: expect.stringMatching(/^CAQSjQcKEAgSGAI4AUIIdGhp/u),
        text: "Comparing city name lengths, Canberra at 8 letters is the longest among Berlin, Tokyo, Canberra, and Ottawa. For the second task on latitude, Reykjavik at roughly 64°N is furthest from the equator compared to Oslo, Lima, and Nairobi—I'll handle this as a separate step after the first, per the user's request.",
        type: "reasoning.text",
      },
    ]);
  });

  it("keeps Gemini text and encrypted blocks that share index 0 apart", async () => {
    const result = await streamedCompletion("bifrost__google__gemini-3.6-flash.sse");

    expect(result.toolCalls?.map(({ id }) => id)).toEqual(["call_34683"]);
    expect(result.reasoningDetails).toEqual([
      {
        index: 0,
        text: "**Listing Capitals**\n\nI've begun by identifying the specific countries the user is interested in and am now compiling a list of their respective capitals. My next step will be to determine the letter count for each capital city.\n\n",
        type: "reasoning.text",
      },
      {
        data: expect.stringMatching(/^AY89a1\/pPf9RsH1p/u),
        id: "call_34683",
        index: 0,
        type: "reasoning.encrypted",
      },
    ]);
  });

  it("carries the first parallel Gemini tool call id on the encrypted block", async () => {
    const result = await streamedCompletion(
      "openrouter-direct__google__gemini-3.6-flash__parallel.sse",
    );

    expect(result.toolCalls?.map(({ id }) => id)).toEqual(["call_92698", "call_92701"]);
    expect(result.reasoningDetails).toEqual([
      {
        data: expect.stringMatching(/^AY89a1\+2R\+xt3Fq9/u),
        format: "google-gemini-v1",
        id: "call_92698",
        index: 0,
        type: "reasoning.encrypted",
      },
    ]);
  });

  it("concatenates gpt-5 summary fragments ahead of the encrypted block", async () => {
    const result = await streamedCompletion("bifrost__openai__gpt-5-nano.sse");

    expect(result.reasoningDetails).toEqual([
      {
        index: 0,
        summary:
          "**Determining capital cities**\n\nI'm figuring out which capital city has the most letters among Germany (Berlin), Japan (Tokyo), Australia (Canberra), and Canada (Ottawa). After counting the letters, I see Canberra has 8 letters, while the others have fewer. So, Canberra, Australia is the answer. I’ll now get the current weather there using the get_weather tool with the city set to \"Canberra.\" It's time to call the tool and present the weather results.",
        type: "reasoning.summary",
      },
      {
        data: expect.stringMatching(/^gAAAAABqzN-Zo094/u),
        id: "rs_0b51bc9e3c71d77c016accdf97ae2887d1869792710d130d79",
        index: 1,
        type: "reasoning.encrypted",
      },
    ]);
  });
});

describe("chat completion reasoning details", () => {
  it("exposes the array only when every entry is a reasoning block", async () => {
    const signed: ReasoningDetail = {
      index: 0,
      signature: "sig==",
      text: "Plan.",
      type: "reasoning.text",
    };
    const encrypted: ReasoningDetail = { data: "opaque", id: "rs_1", type: "reasoning.encrypted" };
    const candidates: readonly unknown[] = [
      undefined,
      [],
      signed,
      [signed, { text: "orphan" }],
      [signed, { type: "summary" }],
      [signed, null],
      [signed, encrypted],
    ];

    const exposed = await Promise.all(
      candidates.map(async (reasoningDetails) => {
        const message = { content: "done", reasoning_details: reasoningDetails, role: "assistant" };
        const result = await completion(() =>
          Response.json({ choices: [{ finish_reason: "stop", index: 0, message }] }),
        );
        return result.reasoningDetails;
      }),
    );

    expect(exposed).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [signed, encrypted],
    ]);
  });
});
