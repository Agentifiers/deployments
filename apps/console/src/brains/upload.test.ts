import { describe, expect, test } from "bun:test";
import {
  BRAIN_FILE_PROBLEMS,
  brainFileProblem,
  brainMediaType,
  CONSOLE_BRAIN_UPLOAD_MAX_BYTES,
  CONSOLE_BRAIN_UPLOAD_MAX_LABEL,
  nextUploadStep,
} from "./upload.ts";

describe("brainMediaType", () => {
  test("the extension decides over a blank or vendor browser type", () => {
    expect(brainMediaType("notes.MD", "")).toBe("text/markdown");
    expect(brainMediaType("report.csv", "application/vnd.ms-excel")).toBe("text/csv");
    expect(brainMediaType("page.htm", "")).toBe("text/html");
    expect(brainMediaType("README", "text/plain")).toBe("text/plain");
    expect(brainMediaType("slides.pptx", "application/vnd.ms-powerpoint")).toBeUndefined();
  });
});

describe("brainFileProblem", () => {
  test("refuses empty, oversized, and unsupported files before any request", () => {
    expect(CONSOLE_BRAIN_UPLOAD_MAX_BYTES).toBe(3_362_712);
    expect(CONSOLE_BRAIN_UPLOAD_MAX_LABEL).toBe("3.2 MB");
    const file = (name: string, size: number) => ({ name, size, type: "" });
    expect(brainFileProblem(file("a.md", 0))).toBe("empty");
    expect(brainFileProblem(file("a.pdf", 3_362_712))).toBeUndefined();
    expect(brainFileProblem(file("a.pdf", 3_362_713))).toBe("too_large");
    expect(brainFileProblem(file("a.docx", 10))).toBe("unsupported_type");
    expect(BRAIN_FILE_PROBLEMS.too_large).toBe(
      "The console uploads files up to 3.2 MB (3,362,712 bytes). Upload larger files, up to 8 MB, through the API.",
    );
  });
});

describe("nextUploadStep", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");
  const expiring = (secondsLeft: number) =>
    new Date(now.getTime() + secondsLeft * 1_000).toISOString();

  test("puts an issued ticket and captures a stored one while time remains", () => {
    expect(nextUploadStep({ expiresAt: expiring(240), status: "issued" }, now)).toBe("put");
    expect(nextUploadStep({ expiresAt: expiring(240), status: "completed" }, now)).toBe("capture");
  });

  test("replays the capture of a consumed ticket however late", () => {
    expect(nextUploadStep({ expiresAt: expiring(-600), status: "consumed" }, now)).toBe("capture");
  });

  test("restarts a ticket that can no longer finish", () => {
    expect(nextUploadStep({ expiresAt: expiring(10), status: "issued" }, now)).toBe("restart");
    expect(nextUploadStep({ expiresAt: expiring(10), status: "completed" }, now)).toBe("restart");
    for (const status of ["expired", "rejected", "streaming"] as const) {
      expect(nextUploadStep({ expiresAt: expiring(240), status }, now)).toBe("restart");
    }
  });
});
