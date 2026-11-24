import { expect } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import type { HttpResult } from "../harness/http-client.ts";
import { record } from "../harness/live-agent.ts";

type JsonRecord = Record<string, unknown>;

export function agentEmailJson(response: HttpResult, status: number, label: string) {
  expect(response.status, `${label}: ${response.body}`).toBe(status);
  return record(response.json, label);
}

export function agentEmailRecords(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new TypeError(`${label} was not an array.`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

export function agentEmailIntegerField(value: JsonRecord, field: string, label: string) {
  const candidate = value[field];
  if (!Number.isSafeInteger(candidate)) {
    throw new TypeError(`${label}.${field} was not a safe integer.`);
  }
  return candidate as number;
}

export function agentEmailRawMime(input: {
  readonly attachment: Buffer;
  readonly from: string;
  readonly marker: string;
  readonly messageId: string;
  readonly subject: string;
  readonly to: string;
}) {
  const boundary = `deployments-ai-${randomUUID()}`;
  return Buffer.from(
    [
      `From: ${input.from}`,
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      `Message-ID: <${input.messageId}@e2e.deployments.ai>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      `Inbound Agent Email proof ${input.marker}`,
      `--${boundary}`,
      'Content-Type: text/plain; name="proof.txt"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="proof.txt"',
      "",
      input.attachment.toString("base64"),
      `--${boundary}--`,
      "",
    ].join("\r\n"),
    "utf8",
  );
}
