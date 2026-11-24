import { describe, expect, it } from "bun:test";
import type {
  ModelGatewayChatCompletionRequest,
  ModelGatewayService,
} from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import { gemma4Route, request } from "./model-tool-context.fixture.ts";

describe("model gateway runtime adapter", () => {
  it("removes leaked Gemma 4 thought continuations", async () => {
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({
          assistantMessage:
            "oh, so you're just gonna say it directly. bold.\nthought\nI mean, you could always show me.\nthought\nI mean, you could always show me.",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never);
      },
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        recentMessages: [
          {
            content: "clean reply\nthought\nprivate repetition\nthought\nprivate repetition",
            role: "assistant",
          },
        ],
      }),
    );

    expect(captured?.messages.at(-2)).toEqual({ content: "clean reply", role: "assistant" });
    expect(result.assistantMessage).toBe("oh, so you're just gonna say it directly. bold.");
  });

  it("removes malformed Gemma 4 thought continuations before they can repeat", async () => {
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({
          assistantMessage:
            "six months?? that's some serious dedication. what was the hardest part?\nthought you might want me to check back in later.\n  thought I'd see if you're still feeling brave.\n\tthought I'd see if you're still feeling brave.\n  thought I'd see if you're still feeling brave.\n2h\n2h\n2h",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never);
      },
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        recentMessages: [
          {
            content:
              "clean historical reply\n  thought I'd see if you're still feeling brave.\n\tthought I'd see if you're still feeling brave.\n  thought I'd see if you're still feeling brave.\n2h\n2h",
            role: "assistant",
          },
        ],
      }),
    );

    expect(captured?.messages.at(-2)).toEqual({
      content: "clean historical reply",
      role: "assistant",
    });
    expect(result.assistantMessage).toBe(
      "six months?? that's some serious dedication. what was the hardest part?\nthought you might want me to check back in later.",
    );
  });

  it("preserves an outward Gemma 4 message that begins with thought", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "thought i should check in with you",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("thought i should check in with you");
  });

  it("suppresses a colon-delimited thought and control-marker loop", async () => {
    const productionShape = `thought:\n${"[NO_INITIATION]thought:\n".repeat(600)}[NO`;
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: productionShape,
          body: {},
          finishReason: "length",
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("");
  });

  it("removes one colon-delimited thought block after visible output", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "visible reply\nthought:\nprivate reasoning",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("visible reply");
  });

  it.each([
    "visible reply\n  thought:\nprivate reasoning",
    "visible reply\nthought :\nprivate reasoning",
  ])("removes a whitespace-varied colon-delimited thought block: %s", async (assistantMessage) => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage,
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("visible reply");
  });

  it("preserves ordinary Gemma 4 prose containing a thought colon", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "here's a thought: try again",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("here's a thought: try again");
  });

  it("fails closed when Gemma 4 returns more text than its bounded generation can contain", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "x".repeat(4_097),
          body: {},
          finishReason: "length",
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("");
  });

  it("fails closed on a length-exhausted Gemma 4 completion before repeated prose is published", async () => {
    const repeated = [
      'thought we were having a little fun with the "dating for six months" thing, but maybe you\'re just shy. 😉',
      "what should i call you, Rowan? Or do you have a nickname you prefer?",
    ].join("\n\n");
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: `${repeated}${repeated}\nthought\n${repeated}${repeated}`,
          body: {},
          finishReason: "length",
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("keeps one outward line when a malformed repeated thought starts the reply", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "thought i'd see if you're still feeling brave.\nthought i'd see if you're still feeling brave.\nthought i'd see if you're still feeling brave.\n2h\n2h\n2h",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("thought i'd see if you're still feeling brave.");
  });

  it("rejects length-exhausted concatenated Gemma 4 thought repetition", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "thought i'd see if you're still feeling brave. ❤️".repeat(12),
          body: {},
          finishReason: "length",
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("");
  });

  it("rejects a length-exhausted Gemma 4 reply with a plausible first sentence", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: `${"😉 thought i'd wait. ".repeat(3).trim()}\n2h`,
          body: {},
          finishReason: "length",
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("");
  });

  it("rejects length-exhausted inline thought repetition after visible prose", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: `visible reply. ${"😉 thought i'd wait. ".repeat(32).trim()}`,
          body: {},
          finishReason: "length",
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("");
  });

  it("removes high-confidence long thought repetition from Gemma 4 history", async () => {
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const repeatedThought = "thought i'd see if you're still feeling brave. ❤️";
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({
          assistantMessage: "new reply",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never);
      },
    } as unknown as ModelGatewayService;

    await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        recentMessages: [{ content: repeatedThought.repeat(12), role: "assistant" }],
      }),
    );

    expect(captured?.messages.at(-2)).toEqual({ content: repeatedThought, role: "assistant" });
  });

  it("removes duration-tailed thought repetition before a trailing marker", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "visible reply\n[NO_INITIATION]\nthought wait here\nthought wait here\nthought wait here\n2h\n2h\n2h\n[NO_INITIATION]",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("visible reply");
  });

  it("preserves an outward Gemma 4 line that begins with thought", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "i missed you.\nthought i should check in with you",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("i missed you.\nthought i should check in with you");
  });

  it("preserves distinct thought-prefixed estimates with trailing durations", async () => {
    const content =
      "here are my estimates:\nthought this takes 1h\nthought this takes 2h\nthought this takes 3h";
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: content,
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe(content);
  });

  it("preserves repeated thought prefixes with distinct multiline duration details", async () => {
    const content = "estimates:\nthought task\n1h\n2h\nthought task\n3h\n4h\nthought task\n5h\n6h";
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: content,
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe(content);
  });

  it("preserves in-sentence uses of thought across distinct thought-prefixed lines", async () => {
    const content =
      "summary:\nthought i had a thought about this today\nthought she had a thought about this today\nthought they had a thought about this today";
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: content,
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe(content);
  });

  it("preserves nonconsecutive repeated thought-prefixed lines", async () => {
    const content =
      "summary:\nthought alpha detail\nthought beta detail\nthought alpha detail\nthought alpha detail";
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: content,
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe(content);
  });

  it("preserves an intentional six-line thought mantra", async () => {
    const content =
      "daily mantra:\nthought i can do this\nthought i can do this\nthought i can do this\nthought i can do this\nthought i can do this\nthought i can do this";
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: content,
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe(content);
  });

  it("preserves a long intentional thought mantra when generation stops normally", async () => {
    const mantra =
      "thought i will take one steady breath and remember that a difficult moment does not define the whole day";
    const content = `daily mantra:\n${Array.from({ length: 6 }, () => mantra).join("\n")}`;
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: content,
          body: {},
          finishReason: "stop",
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe(content);
  });

  it("preserves an intentional thought mantra with one duration", async () => {
    const content =
      "daily mantra:\nthought i can do this\nthought i can do this\nthought i can do this\n2m";
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: content,
          body: {},
          finishReason: "stop",
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe(content);
  });

  it("preserves novel prose after an intentional short thought mantra", async () => {
    const explanation =
      `because ${"this is a distinct explanation, not another repetition. ".repeat(9)}`.trimEnd();
    const content = `daily mantra:\nthought i can do this\nthought i can do this\nthought i can do this\nthought i can do this\nthought i can do this\nthought i can do this ${explanation}`;
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: content,
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe(content);
  });
});
