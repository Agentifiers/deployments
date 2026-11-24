import { describe, expect, it } from "bun:test";
import { imageInputModelChain, imageInputSupport } from "./image-input.ts";

const row = (imageInput: boolean, status: "active" | "retired" = "active") => ({
  capabilities: { imageInput },
  status,
});

describe("image input support", () => {
  it("lets an active catalog row override the curated table", () => {
    const glm = "openrouter/z-ai/glm-5.2";

    expect(imageInputSupport(glm, new Map())).toBe("unsupported");
    expect(imageInputSupport(glm, new Map([[glm, row(true)]]))).toBe("supported");
    expect(imageInputSupport(glm, new Map([[glm, row(true, "retired")]]))).toBe("unsupported");
    expect(imageInputSupport("openai/gpt-4o", new Map([["openai/gpt-4o", row(false)]]))).toBe(
      "unsupported",
    );
  });

  it("is unknown for a model with neither an active catalog row nor a curated entry", () => {
    const granted = "openrouter/vendor/operator-granted";

    expect(imageInputSupport(granted, new Map())).toBe("unknown");
    expect(imageInputSupport(granted, new Map([[granted, row(true, "retired")]]))).toBe("unknown");
    expect(imageInputSupport(granted, new Map([[granted, row(true)]]))).toBe("supported");
  });

  it("keeps the primary first and drops fallbacks that cannot take images", () => {
    expect(
      imageInputModelChain(
        { modelFallbackIds: ["text-only", "vision-fallback", "unknown"], modelId: "vision" },
        new Map([
          ["vision", "supported"],
          ["text-only", "unsupported"],
          ["vision-fallback", "supported"],
          ["unknown", "unknown"],
        ]),
      ),
    ).toEqual({ kind: "accepted", modelFallbackIds: ["vision-fallback"] });
    expect(
      imageInputModelChain(
        { modelFallbackIds: ["vision-fallback"], modelId: "text-only" },
        new Map([
          ["text-only", "unsupported"],
          ["vision-fallback", "supported"],
        ]),
      ),
    ).toEqual({ kind: "primary-unaccepted", support: "unsupported" });
  });
});
