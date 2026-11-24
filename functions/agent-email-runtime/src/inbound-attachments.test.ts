import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentEmailInboundWorkflowResult } from "./inbound-consumer.ts";
import {
  ARTIFACT_BUCKET,
  CAPTURE_ROLE_ARN,
  attachmentObject,
  attachmentObjectOf,
  emailAttachmentId,
  emailWorkflow,
  extractedText,
  legacyWordAttachment,
  message,
  oversizedPdfAttachment,
  platformAgent,
  png,
  type EmailFile,
} from "./inbound-attachments.fixture.ts";

const PNG_SHA256 = "10d5715fc6a5c6daaa6b41861115d8e46ca4f0859b667030ff12e14fe652705e";
const PDF_SHA256 = "f66037b0169c8befb7e9f7ad09e83e469f6fcdbb1c73147a0bf41edd61a0e6ff";
const FIRST_AGENT_COPY = "09HQD4ZP9GY4HH4497ANSNRP6S";
const SECOND_AGENT_COPY = "01R6P00TJ1SYY1K83KNME2QFJB";
const customerKey = (artifactId: string, sha256: string, objectName: string) =>
  `artifacts/organizations/${message.organizationId}/projects/${message.projectId}/environments/${message.environmentId}/customer/${artifactId}/${sha256}/${objectName}`;

const quarterlyPdf: EmailFile = {
  bytes: new TextEncoder().encode("%PDF-1.7\nQ3 revenue by region"),
  contentType: "application/pdf",
  disposition: "attachment",
  fileName: "q3.pdf",
};
const sitePhoto: EmailFile = {
  bytes: png,
  contentType: "image/png",
  disposition: "attachment",
  fileName: "site-photo.png",
};
const inlineLogo = (position: number): EmailFile => ({
  bytes: png.with(-1, position),
  contentType: "image/png",
  disposition: "inline",
  fileName: `logo-${position}.png`,
});

function submitted(result: AgentEmailInboundWorkflowResult) {
  return result.submissions.map(({ bindingId, result: turn }) => ({
    bindingId,
    created: turn.created,
    inputArtifacts: turn.run.data.inputArtifacts,
    runId: turn.run.data.id,
    threadId: turn.run.data.threadId,
  }));
}

afterEach(() => {
  mock.restore();
});

describe("agent email attachments", () => {
  test("each bound agent that opts in gets its own copy of the image on its own thread", async () => {
    const first = platformAgent("1");
    const second = platformAgent("2");
    const workflow = emailWorkflow([first, second]);

    const delivered = submitted(await workflow.deliver());

    expect(delivered).toEqual([
      {
        bindingId: first.binding.data.id,
        created: true,
        inputArtifacts: [FIRST_AGENT_COPY],
        runId: expect.any(String),
        threadId: first.threadId,
      },
      {
        bindingId: second.binding.data.id,
        created: true,
        inputArtifacts: [SECOND_AGENT_COPY],
        runId: expect.any(String),
        threadId: second.threadId,
      },
    ]);
    for (const [agent, artifactId] of [
      [first, FIRST_AGENT_COPY],
      [second, SECOND_AGENT_COPY],
    ] as const) {
      const artifact = await workflow.artifact(artifactId);
      expect(artifact?.data).toMatchObject({
        input: { kind: "image", mediaType: "image/png" },
        name: "receipt.png",
        owner: {
          sourceId: agent.binding.data.id,
          sourceKind: "agent-email-binding",
          type: "ingress",
        },
        status: "available",
        storage: {
          bucket: ARTIFACT_BUCKET,
          byteSize: png.byteLength,
          contentType: "application/octet-stream",
          key: customerKey(artifactId, PNG_SHA256, "@input"),
          sha256: PNG_SHA256,
        },
        threadId: agent.threadId,
        type: "input",
      });
      expect(
        workflow.artifactBucket.objects.get(customerKey(artifactId, PNG_SHA256, "@input"))?.bytes,
      ).toEqual(png);
    }
    expect(workflow.extraction.requests).toEqual([]);
    expect(workflow.emailBucket.reads).toEqual([attachmentObject]);

    const redelivered = submitted(await workflow.deliver());

    expect(redelivered).toEqual(delivered.map((turn) => ({ ...turn, created: false })));
    expect(workflow.emailBucket.reads).toEqual([attachmentObject]);
    expect(workflow.artifactBucket.objects.size).toBe(2);
  });

  test("bound agents that receive one PDF share a single extraction and each store its text", async () => {
    const workflow = emailWorkflow([platformAgent("1"), platformAgent("2")], {
      files: [quarterlyPdf],
    });

    const delivered = submitted(await workflow.deliver());

    expect(delivered.map(({ inputArtifacts }) => inputArtifacts)).toEqual([
      [FIRST_AGENT_COPY],
      [SECOND_AGENT_COPY],
    ]);
    expect(
      workflow.extraction.requests.map(({ hint, source }) => ({
        hint,
        sha256: source.sha256,
      })),
    ).toEqual([
      {
        hint: { contentType: "application/pdf", fileName: "q3.pdf" },
        sha256: PDF_SHA256,
      },
    ]);
    for (const artifactId of [FIRST_AGENT_COPY, SECOND_AGENT_COPY]) {
      expect((await workflow.artifact(artifactId))?.data).toMatchObject({
        input: { kind: "document", mediaType: "application/pdf", summary: "PDF, 1 page" },
        name: "q3.pdf",
        status: "available",
        storage: { fileName: "@input", key: customerKey(artifactId, PDF_SHA256, "@input") },
      });
      expect(
        workflow.artifactBucket.objects.get(
          customerKey(artifactId, PDF_SHA256, "text/document-text-v1.txt"),
        )?.bytes,
      ).toEqual(extractedText);
    }
  });

  test("both bindings store their copies through one capture session tagged with their tenant", async () => {
    const workflow = emailWorkflow([platformAgent("1"), platformAgent("2")]);

    await workflow.deliver();
    await workflow.deliver();

    expect(workflow.artifactBucket.objects.size).toBe(2);
    expect(workflow.capture.assumed).toEqual([
      {
        DurationSeconds: 900,
        RoleArn: CAPTURE_ROLE_ARN,
        RoleSessionName: "email-attachment-capture",
        Tags: [
          { Key: "environmentId", Value: "01ARZ3NDEKTSV4RRFFQ69G0002" },
          { Key: "organizationId", Value: "01ARZ3NDEKTSV4RRFFQ69G0001" },
          { Key: "projectId", Value: "01ARZ3NDEKTSV4RRFFQ69G0005" },
        ],
      },
    ]);
  });

  test("a transient email-bucket read failure submits nothing, and redelivery attaches the image", async () => {
    const agent = platformAgent("1");
    const workflow = emailWorkflow([agent]);
    workflow.emailBucket.failures.nextGet = true;

    const failure = await workflow.deliver().then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toMatchObject({
      failures: [{ bindingId: agent.binding.data.id, cause: { name: "SlowDown" } }],
      submissions: [],
    });
    expect(workflow.storedRunCount()).toBe(0);

    const redelivered = submitted(await workflow.deliver());

    expect(redelivered).toEqual([
      {
        bindingId: agent.binding.data.id,
        created: true,
        inputArtifacts: [FIRST_AGENT_COPY],
        runId: expect.any(String),
        threadId: agent.threadId,
      },
    ]);
    expect(workflow.storedRunCount()).toBe(1);
  });

  test("a release without the opt-in reads nothing, logs nothing, and runs without the image", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const agent = platformAgent("1", {});
    const workflow = emailWorkflow([agent]);

    const result = await workflow.deliver();

    expect(result.submissions[0]?.result).toMatchObject({
      created: true,
      omittedInputArtifacts: [
        { artifactId: FIRST_AGENT_COPY, reason: "ingress_attachments_disabled" },
      ],
    });
    expect(result.submissions[0]?.result.run.data.inputArtifacts).toBeUndefined();
    expect(workflow.emailBucket.reads).toEqual([]);
    expect(workflow.artifactBucket.objects.size).toBe(0);
    expect(workflow.capture.assumed).toEqual([]);
    expect(warn.mock.calls).toEqual([]);
  });

  test("an attachment that is gone or no longer matches its digest is left out and logged", async () => {
    for (const emailObject of [{ missing: 403 }, { missing: 404 }, png.with(8, 0x00)] as const) {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const agent = platformAgent("1");
      const workflow = emailWorkflow([agent], { emailObject });

      const result = await workflow.deliver();

      expect(result.submissions[0]?.result).toMatchObject({
        created: true,
        omittedInputArtifacts: [
          { artifactId: FIRST_AGENT_COPY, reason: "input_artifact_unavailable" },
        ],
      });
      expect(result.submissions[0]?.result.run.data.inputArtifacts).toBeUndefined();
      expect(workflow.artifactBucket.objects.size).toBe(0);
      expect(warn.mock.calls).toEqual([
        [
          "Agent email attachments were left out of the run.",
          {
            bindingId: agent.binding.data.id,
            messageId: message.messageId,
            notAttached: [{ artifactId: FIRST_AGENT_COPY, reason: "input_artifact_unavailable" }],
            notCaptured: [{ artifactId: FIRST_AGENT_COPY, reason: "unreadable" }],
            skipped: [],
          },
        ],
      ]);
      warn.mockRestore();
    }
  });

  test("a legacy Word file and a 12 MiB PDF are never read, and every delivery names them to the agent", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const agent = platformAgent("1");
    const workflow = emailWorkflow([agent], {
      attachments: [legacyWordAttachment, oversizedPdfAttachment, ...message.attachments],
    });

    const first = await workflow.deliver();
    const delivered = submitted(first);

    expect(delivered.map(({ inputArtifacts }) => inputArtifacts)).toEqual([[FIRST_AGENT_COPY]]);
    expect(workflow.emailBucket.reads).toEqual([attachmentObject]);
    expect(warn.mock.calls).toEqual([
      [
        "Agent email attachments were left out of the run.",
        {
          bindingId: agent.binding.data.id,
          messageId: message.messageId,
          notAttached: [],
          notCaptured: [],
          skipped: [
            {
              identity: { emailAttachmentId: legacyWordAttachment.id, type: "email-attachment" },
              name: "contract.doc",
              reason: "legacy_office_format",
            },
            {
              identity: { emailAttachmentId: oversizedPdfAttachment.id, type: "email-attachment" },
              name: "annual-report.pdf",
              reason: "too_large",
            },
          ],
        },
      ],
    ]);
    expect(first.submissions.map(({ result }) => result.message.data.inputOmissions)).toEqual([
      [
        { name: "contract.doc", reason: "legacy_office_format" },
        { name: "annual-report.pdf", reason: "too_large" },
      ],
    ]);

    const redelivered = submitted(await workflow.deliver());

    expect(redelivered).toEqual(delivered.map((turn) => ({ ...turn, created: false })));
  });

  test("inline logos rank after the attached photo and PDF, so they only fill the image slots left", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const agent = platformAgent("1");
    const workflow = emailWorkflow([agent], {
      files: [inlineLogo(1), inlineLogo(2), inlineLogo(3), inlineLogo(4), sitePhoto, quarterlyPdf],
    });

    const [turn] = submitted(await workflow.deliver());
    const inputs = await Promise.all(
      (turn?.inputArtifacts ?? []).map((artifactId) => workflow.artifact(artifactId)),
    );

    expect(inputs.map((artifact) => artifact?.data.name)).toEqual([
      "site-photo.png",
      "q3.pdf",
      "logo-1.png",
      "logo-2.png",
      "logo-3.png",
    ]);
    expect(workflow.emailBucket.reads).toEqual(
      [4, 5, 0, 1, 2].map((ordinal) => attachmentObjectOf(emailAttachmentId(ordinal))),
    );
    expect(warn.mock.calls).toEqual([
      [
        "Agent email attachments were left out of the run.",
        {
          bindingId: agent.binding.data.id,
          messageId: message.messageId,
          notAttached: [],
          notCaptured: [],
          skipped: [
            {
              identity: { emailAttachmentId: emailAttachmentId(3), type: "email-attachment" },
              name: "logo-4.png",
              reason: "over_turn_cap",
            },
          ],
        },
      ],
    ]);
  });

  test("a transient extraction or store failure submits nothing, and redelivery attaches the PDF", async () => {
    for (const { cause, extractions, failing } of [
      { cause: "ExtractionUnavailableError", extractions: 2, failing: "extraction" },
      { cause: "ServiceUnavailable", extractions: 1, failing: "store" },
    ] as const) {
      const agent = platformAgent("1");
      const workflow = emailWorkflow([agent], { files: [quarterlyPdf] });
      if (failing === "extraction") workflow.extraction.failures.next = true;
      else workflow.artifactBucket.failures.nextPut = true;

      const failure = await workflow.deliver().then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({
        failures: [{ bindingId: agent.binding.data.id, cause: { name: cause } }],
        submissions: [],
      });
      expect(workflow.storedRunCount()).toBe(0);
      expect((await workflow.artifact(FIRST_AGENT_COPY))?.data.status).toBe("pending");

      const redelivered = submitted(await workflow.deliver());

      expect(redelivered.map(({ inputArtifacts }) => inputArtifacts)).toEqual([[FIRST_AGENT_COPY]]);
      expect((await workflow.artifact(FIRST_AGENT_COPY))?.data).toMatchObject({
        input: { kind: "document", mediaType: "application/pdf", summary: "PDF, 1 page" },
        status: "available",
      });
      expect(workflow.extraction.requests).toHaveLength(extractions);
    }
  });

  test("a PDF with no text layer is named to the agent as left out, and the run still starts", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const agent = platformAgent("1");
    const workflow = emailWorkflow([agent], {
      extraction: { reason: "no_text", status: "unusable" },
      files: [{ ...quarterlyPdf, fileName: "scan.pdf" }],
    });

    const result = await workflow.deliver();

    expect(result.submissions[0]?.result).toMatchObject({
      created: true,
      message: { data: { inputOmissions: [{ name: "scan.pdf", reason: "no_text" }] } },
      omittedInputArtifacts: [{ artifactId: FIRST_AGENT_COPY, reason: "input_file_no_text" }],
    });
    expect(result.submissions[0]?.result.run.data.inputArtifacts).toBeUndefined();
    expect((await workflow.artifact(FIRST_AGENT_COPY))?.data).toMatchObject({
      input: { kind: "unusable", reason: "no_text" },
      name: "scan.pdf",
      status: "available",
    });
    expect(warn.mock.calls).toEqual([
      [
        "Agent email attachments were left out of the run.",
        {
          bindingId: agent.binding.data.id,
          messageId: message.messageId,
          notAttached: [{ artifactId: FIRST_AGENT_COPY, reason: "input_file_no_text" }],
          notCaptured: [],
          skipped: [],
        },
      ],
    ]);
  });
});
