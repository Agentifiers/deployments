import { describe, expect, it } from "bun:test";
import {
  boundedRuntimeError,
  redactRuntimeSensitivePrefix,
  redactRuntimeSensitiveText,
} from "./redaction.ts";

describe("runtime redaction", () => {
  it("redacts common secret forms before progress or errors are persisted", () => {
    const result = redactRuntimeSensitiveText(
      [
        "authorization=secret",
        "OPENAI_API_KEY=sk-prefixed",
        "AWS_SECRET_ACCESS_KEY=aws-prefixed",
        "DATABASE_PASSWORD=db-prefixed",
        "sk-proj-abcdefghijklmnopqrstuv",
        "ghp_abcdefghijklmnopqrstuvwxyz123456",
        "github_pat_11ABCDEFGH0123456789_abcdefghijklmnopqrstuvwxyz0123456789",
        "xoxb-1234567890-abcdefghijklmnop",
        "Authorization: Basic dXNlcjpwYXNz",
        'password="correct horse battery staple"',
        '{"apiKey":"sk-live-json","privateKey":"-----BEGIN PRIVATE KEY-----\\njson-key\\n-----END PRIVATE KEY-----"}',
        "-----BEGIN OPENSSH PRIVATE KEY-----\nstandalone-key\n-----END OPENSSH PRIVATE KEY-----",
        "Bearer token123",
        "https://user:pass@example.test",
        "postgresql://db-user:db-pass@database.example.test/app",
        "postgresql://at-user:p@ss@at-database.example.test/app",
        "redis://cache-user:cache-pass@cache.example.test:6379",
        "mongodb+srv://mongo-user:mongo-pass@cluster.example.test/app",
        "AKIAABCDEFGHIJKLMNOP",
      ].join(" "),
    );
    expect(result).not.toContain("secret");
    expect(result).not.toContain("sk-prefixed");
    expect(result).not.toContain("aws-prefixed");
    expect(result).not.toContain("db-prefixed");
    expect(result).not.toContain("sk-proj-");
    expect(result).not.toContain("ghp_");
    expect(result).not.toContain("github_pat_");
    expect(result).not.toContain("xoxb-");
    expect(result).not.toContain("dXNlcjpwYXNz");
    expect(result).not.toContain("correct horse battery staple");
    expect(result).not.toContain("sk-live-json");
    expect(result).not.toContain("json-key");
    expect(result).not.toContain("standalone-key");
    expect(result).not.toContain("token123");
    expect(result).not.toContain("user:pass");
    expect(result).not.toContain("db-user:db-pass");
    expect(result).not.toContain("p@ss");
    expect(result).not.toContain("cache-user:cache-pass");
    expect(result).not.toContain("mongo-user:mongo-pass");
    expect(result).toContain("postgresql://[redacted]@database.example.test/app");
    expect(result).toContain("postgresql://[redacted]@at-database.example.test/app");
    expect(result).toContain("redis://[redacted]@cache.example.test:6379");
    expect(result).toContain("mongodb+srv://[redacted]@cluster.example.test/app");
    expect(result).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });

  it("redacts secret blocks and quoted values cut off by a bounded prefix", () => {
    const result = redactRuntimeSensitivePrefix(
      'prefix password="unterminated value -----BEGIN PRIVATE KEY-----\npartial-key',
    );
    expect(result).not.toContain("unterminated value");
    expect(result).not.toContain("partial-key");
    expect(result).toContain("[redacted]");
    expect(
      boundedRuntimeError(
        new Error('password="multi word secret -----BEGIN PRIVATE KEY-----\npartial-key'),
        "failed",
      ),
    ).not.toContain("partial-key");
  });

  it("redacts only a terminated quoted value and keeps the rest of the bounded prefix", () => {
    const result = redactRuntimeSensitivePrefix(
      '{"credential":"initial","echo":"E2E callback echo: proof","marker":"proof","token":"cut',
    );
    expect(result).toBe(
      '{credential=[redacted],"echo":"E2E callback echo: proof","marker":"proof",token=[redacted]',
    );
    expect(redactRuntimeSensitivePrefix('{"password":"a\\"b","status":"denied"}')).toBe(
      '{password=[redacted],"status":"denied"}',
    );
  });

  it("redacts URL credentials cut off before the host at a bounded prefix", () => {
    const result = redactRuntimeSensitivePrefix(
      `prefix postgresql://db-user:boundary-secret-${"s".repeat(200)}`,
    );
    expect(result).not.toContain("db-user");
    expect(result).not.toContain("boundary-secret");
    expect(result).toContain("postgresql://[redacted]");
  });

  it("preserves ordinary URL ports in bounded diagnostics", () => {
    expect(redactRuntimeSensitivePrefix("failed at http://localhost:3000")).toContain(
      "http://localhost:3000",
    );
    expect(redactRuntimeSensitivePrefix("failed at https://service.internal:8443")).toContain(
      "https://service.internal:8443",
    );
    expect(redactRuntimeSensitivePrefix("failed postgresql://db-user:1234")).toBe(
      "failed postgresql://[redacted]",
    );
  });

  it("redacts unquoted secret assignments through a safe delimiter", () => {
    const result = redactRuntimeSensitiveText(
      "authentication failed password=correct horse battery staple; status=denied",
    );
    expect(result).not.toContain("correct horse battery staple");
    expect(result).toContain("password=[redacted]");
    expect(result).toContain("status=denied");
  });
});
