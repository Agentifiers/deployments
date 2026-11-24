import { optionalToolString, type ProviderNativeBody } from "../core.ts";

export function microsoftFileBody(input: Record<string, unknown>): ProviderNativeBody {
  const contentType = optionalToolString(input, "contentType") ?? "application/octet-stream";
  const contentBase64 = optionalToolString(input, "contentBase64");
  if (contentBase64) {
    return { body: Buffer.from(contentBase64, "base64"), contentType };
  }
  const content = input.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("Tool input content or contentBase64 is required");
  }
  return { body: content, contentType };
}
