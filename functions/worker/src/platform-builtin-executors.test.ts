import { describe, expect, test } from "bun:test";
import { dataBoundaryOf, type DynamoDatabaseService, type Ulid } from "@deployments-ai/db";
import { PDFDocument } from "pdf-lib";
import { APP_TOOL_NAMES, SANDBOX_FILE_TOOL_NAMES } from "@deployments-ai/tools";
import {
  hostedCodeRequest,
  hostedCodeTool,
  scriptedSandbox,
  type SandboxCall,
} from "./hosted-code/executor.fixture.ts";
import {
  createRuntimePlatformBuiltinExecutors,
  type RuntimePlatformBuiltinOptions,
} from "./platform-builtin-executors.ts";
import { HOSTED_CODE_EXECUTOR_KEY } from "./runtime-tool-planning.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";
import {
  chartConnectsPoints,
  chartDomain,
  fitPdfImage,
  pieSliceValues,
} from "./pdf-report-renderer.ts";

const unused = async () => {
  throw new Error("Test dependency must not be invoked.");
};

function executors(overrides: Partial<RuntimePlatformBuiltinOptions> = {}) {
  return createRuntimePlatformBuiltinExecutors({
    artifactBucket: "artifacts",
    artifactKmsKeyId: "arn:aws:kms:us-east-2:123456789012:key/test",
    artifactS3: { send: unused },
    database: {
      deleteRecord: unused,
      getRecord: unused,
      putRecord: unused,
      queryRecords: unused,
      transactWrite: unused,
    } as unknown as DynamoDatabaseService,
    dataBoundaries: { read: async () => dataBoundaryOf(undefined) },
    enqueueRun: unused,
    generateId: unused,
    loadBrowserConfig: () => ({ allowedOrigins: ["https://example.com"], kind: "origins" }),
    loadMemoryPlatform: unused,
    loadWebConfig: () => ({
      baseUrl: "http://127.0.0.1:3002",
      denyPrivateEgress: true,
      jobTicketSecret: "12345678901234567890123456789012",
    }),
    readHostedCodeSecrets: unused,
    sandboxManager: {} as never,
    sandboxProviderName: "aws_lambda_microvm",
    timerProvider: { delete: unused, upsert: unused },
    ...overrides,
  });
}

const request = {
  agentDefinitionId: "01J00000000000000000000001" as Ulid,
  agentDeploymentId: "01J00000000000000000000002" as Ulid,
  agentReleaseId: "01J00000000000000000000003" as Ulid,
  decision: {
    action: "allow" as const,
    reason: "test",
    toolCallId: "01J00000000000000000000009" as Ulid,
  },
  effect: "write" as const,
  environmentId: "01J00000000000000000000004" as Ulid,
  idempotencyKey: "test-call",
  inputSummary: "test",
  organizationId: "01J00000000000000000000005" as Ulid,
  projectId: "01J00000000000000000000006" as Ulid,
  requiredScopes: [],
  runId: "01J00000000000000000000007" as Ulid,
  threadId: "01J00000000000000000000008" as Ulid,
  toolName: "artifact.pdf_report",
};

describe("platform built-in executor composition", () => {
  test("provides an execution plan for every active catalog tool", () => {
    const registry = executors();
    expect(Object.keys(registry)).toHaveLength(76);
    for (const toolName of APP_TOOL_NAMES) expect(registry[toolName]).toBeFunction();
    expect(registry["attachment.read"]).toBeFunction();
    expect(registry["agent.brain.search"]).toBeFunction();
    expect(registry["agent.brain.ask"]).toBeFunction();
    expect(registry["agent.brain.capture"]).toBeFunction();
    expect(registry["agent.brain.get_entity"]).toBeFunction();
    expect(registry["web.search"]).toBeFunction();
    expect(registry["agent.delegate"]).toBeFunction();
    expect(registry["browser.capture_screenshot"]).toBeFunction();
    expect(registry["browser.session.execute"]).toBeFunction();
    expect(registry["code.execute"]).toBeFunction();
    for (const toolName of SANDBOX_FILE_TOOL_NAMES) expect(registry[toolName]).toBeFunction();
    expect(registry["artifact.pdf_report"]).toBeFunction();
    expect(registry["artifact.mermaid_to_diagram"]).toBeFunction();
  });

  test("runs hosted code in a dedicated per-call sandbox, never the thread sandbox", async () => {
    const acquired: unknown[] = [];
    const calls: SandboxCall[] = [];
    const tool = hostedCodeTool("export function handler() { return {}; }", {
      bucket: "artifacts",
      credential: { credentialId: "01ARZ3NDEKTSV4RRFFQ69G5FC9", generation: 1 },
      execution: { secretNames: ["ORDERS_TOKEN"] },
    });
    const threadRequest = hostedCodeRequest(
      {},
      {
        sandboxPolicy: {
          minMemoryMiB: 2_048,
          mode: "thread-persistent",
          poolKey: "agents",
          provider: "aws_lambda_microvm",
        },
      },
    );
    const registry = executors({
      artifactS3: {
        send: async () => ({ Body: { transformToByteArray: async () => tool.bytes } }),
      } as never,
      readHostedCodeSecrets: async () => ({ ORDERS_TOKEN: "tok_live_123" }),
      sandboxManager: scriptedSandbox(calls),
      threadSandbox: {
        acquire: async (input: unknown) => {
          acquired.push(input);
          throw new Error("Hosted code must not acquire the thread sandbox.");
        },
      } as unknown as ThreadSandboxWorkspace,
    });

    const result = await registry[HOSTED_CODE_EXECUTOR_KEY]!(threadRequest, tool.definition);

    expect(result.status).toBe("completed");
    expect(acquired).toEqual([]);
    expect(calls[0]).toMatchObject({
      create: {
        allocationId: threadRequest.decision.toolCallId,
        isolationMode: "run-ephemeral",
        minMemoryMiB: 2_048,
        poolKey: "agents",
      },
    });
    const exec = calls.find((call) => "exec" in call);
    expect(exec && "exec" in exec ? exec.exec : {}).not.toHaveProperty("cwd");
    expect(calls.at(-1)).toEqual({ destroy: true });
  });

  test("builds valid PDF and CSV artifacts", async () => {
    const registry = executors();
    const pdf = await registry["artifact.pdf_report"]!(
      {
        ...request,
        input: {
          blocks: [{ text: "Operational status is green.", type: "paragraph" }],
          citations: [],
          schemaVersion: "2",
          template: { key: "executive-report" },
          title: "Status report",
        },
      },
      {} as never,
    );
    expect(pdf.status).toBe("completed");
    expect(
      Buffer.from(pdf.artifacts?.[0]?.content as Uint8Array)
        .subarray(0, 8)
        .toString(),
    ).toBe("%PDF-1.7");
    expect(pdf.artifacts?.[0]?.visibility).toBe("private");

    const csv = await registry["artifact.spreadsheet_export"]!(
      {
        ...request,
        input: {
          rows: [
            { name: "alpha", value: 1 },
            { name: "beta", value: 2 },
          ],
        },
        toolName: "artifact.spreadsheet_export",
      },
      {} as never,
    );
    expect(csv.artifacts?.[0]?.content).toBe("name,value\r\nalpha,1\r\nbeta,2\r\n");
    expect(csv.artifacts?.[0]?.visibility).toBe("private");
  });

  test("builds an editable Excalidraw artifact from Mermaid", async () => {
    const result = await executors()["artifact.mermaid_to_diagram"]!(
      {
        ...request,
        input: {
          definition: "flowchart TD\nA[Start] --> B{Ready?}\nB -->|Yes| C[Done]",
          fileName: "release flow",
          style: "sketchy",
          theme: "dark",
          title: "Release flow",
        },
        toolName: "artifact.mermaid_to_diagram",
      },
      {} as never,
    );
    const artifact = result.artifacts?.[0];
    const scene = JSON.parse(String(artifact?.content)) as {
      readonly appState: Readonly<Record<string, unknown>>;
      readonly elements: readonly Readonly<Record<string, unknown>>[];
      readonly type: string;
    };
    expect(artifact).toMatchObject({
      contentType: "application/vnd.excalidraw+json",
      fileName: "release-flow.excalidraw",
      label: "Release flow",
      type: "generated_file",
      visibility: "private",
    });
    expect(scene.type).toBe("excalidraw");
    expect(scene.appState.currentItemRoughness).toBe(1);
    expect(scene.elements.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["arrow", "diamond", "rectangle", "text"]),
    );
  });

  test("bounds Unicode diagram artifact labels without changing the scene title", async () => {
    const title = "😀".repeat(200);
    const result = await executors()["artifact.mermaid_to_diagram"]!(
      {
        ...request,
        input: { definition: "flowchart TD\nA[Start]", title },
        toolName: "artifact.mermaid_to_diagram",
      },
      {} as never,
    );
    const artifact = result.artifacts?.[0];
    const scene = JSON.parse(String(artifact?.content)) as {
      readonly elements: readonly Readonly<Record<string, unknown>>[];
    };
    expect(Buffer.byteLength(String(artifact?.label), "utf8")).toBeLessThanOrEqual(512);
    expect(scene.elements.some(({ originalText }) => originalText === title)).toBe(true);
  });

  test("accepts schema-valid astral characters in Mermaid definitions", async () => {
    const result = await executors()["artifact.mermaid_to_diagram"]!(
      {
        ...request,
        input: {
          definition: `%% ${"😀".repeat(25_001)}\nflowchart TD\nA[Safe]`,
        },
        toolName: "artifact.mermaid_to_diagram",
      },
      {} as never,
    );
    expect(result.status).toBe("completed");
  });

  test("renders byte-identical PDF artifacts across wall-clock retries", async () => {
    const executor = executors()["artifact.pdf_report"]!;
    const pdfInput = {
      blocks: [{ text: "Stable retry output.", type: "paragraph" }],
      citations: [],
      schemaVersion: "2",
      template: { key: "executive-report" },
      title: "Deterministic report",
    };
    const first = await executor({ ...request, input: pdfInput }, {} as never);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await executor({ ...request, input: pdfInput }, {} as never);

    expect(second.artifacts?.[0]?.content).toEqual(first.artifacts?.[0]?.content);
  });

  test("renders PDF layout, themes, images, and every chart family", async () => {
    const registry = executors();
    const image = {
      contentBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      contentType: "image/png",
      id: "logo",
    };
    const chartTypes = [
      "bar",
      "stacked-bar",
      "line",
      "area",
      "composed",
      "pie",
      "donut",
      "scatter",
      "sparkline",
      "waterfall",
    ] as const;
    const result = await registry["artifact.pdf_report"]!(
      {
        ...request,
        input: {
          assets: [image],
          blocks: [
            { assetId: "logo", altText: "Logo", caption: "Embedded image", type: "image" },
            ...chartTypes.map((chartType) => ({
              chartType,
              data: [
                { label: "one", value: 2 },
                { label: "two", value: 5 },
              ],
              height: 120,
              series: [{ key: "value", label: "Value" }],
              showDataTable: true,
              title: `${chartType} chart`,
              type: "chart" as const,
              xKey: "label",
            })),
          ],
          citations: [],
          output: {
            includeDataAppendix: true,
            includePageNumbers: true,
            orientation: "landscape",
            pageSize: "A4",
          },
          schemaVersion: "2",
          template: { key: "data-report" },
          theme: {
            accentColor: "#123456",
            backgroundColor: "#fefefe",
            fontFamily: "Times-Roman",
            logoAssetId: "logo",
          },
          title: "Rich report",
        },
      },
      {} as never,
    );
    const artifact = result.artifacts?.[0];
    const document = await PDFDocument.load(artifact?.content as Uint8Array);
    expect(document.getTitle()).toBe("Rich report");
    expect(document.getPages()[0]!.getWidth()).toBeGreaterThan(document.getPages()[0]!.getHeight());
    expect(artifact?.metadata).toMatchObject({ chartCount: 10, templateKey: "data-report" });
    expect(Number(artifact?.metadata?.pageCount)).toBeGreaterThan(1);
  });

  test("uses cumulative domains for stacked and waterfall charts", () => {
    const chart = {
      data: [
        { first: 4, second: 5 },
        { first: -7, second: 0 },
      ],
      series: [
        { key: "first", label: "First" },
        { key: "second", label: "Second" },
      ],
      title: "Domain",
      type: "chart" as const,
      xKey: "label",
    };
    expect(chartDomain({ ...chart, chartType: "stacked-bar" })).toMatchObject({
      maximum: 9,
      minimum: -7,
    });
    expect(chartDomain({ ...chart, chartType: "waterfall" })).toMatchObject({
      maximum: 9,
      minimum: 0,
    });
  });

  test("builds pie and donut slices from category rows", () => {
    const chart = {
      chartType: "pie" as const,
      data: [
        { label: "one", value: 2 },
        { label: "two", value: 5 },
      ],
      series: [{ key: "value", label: "Value" }],
      title: "Categories",
      type: "chart" as const,
      xKey: "label",
    };
    expect(pieSliceValues(chart)).toEqual([2, 5]);
  });

  test("does not connect scatter observations", () => {
    expect(chartConnectsPoints("scatter")).toBe(false);
    expect(chartConnectsPoints("line")).toBe(true);
  });

  test("fits extreme portrait images within the printable page", () => {
    expect(
      fitPdfImage({
        availableHeight: 680,
        availableWidth: 500,
        naturalHeight: 8_192,
        naturalWidth: 1,
        requestedHeight: 1_000_000,
      }),
    ).toEqual({ height: 680, width: 0.0830078125 });
  });

  test("normalizes the legacy PDF input advertised by the catalog", async () => {
    const result = await executors()["artifact.pdf_report"]!(
      {
        ...request,
        input: {
          sections: [{ body: "Legacy section body", heading: "Legacy section" }],
          sourceCitations: ["https://example.com/source"],
          title: "Legacy report",
        },
      },
      {} as never,
    );
    const document = await PDFDocument.load(result.artifacts?.[0]?.content as Uint8Array);
    expect(document.getTitle()).toBe("Legacy report");
  });

  test("preserves Unicode text in PDF metadata and rendered content", async () => {
    const title = "Статус 東京 مرحبا";
    const result = await executors()["artifact.pdf_report"]!(
      {
        ...request,
        input: {
          blocks: [{ text: "Résumé — данные — 分析 — تقرير", type: "paragraph" }],
          citations: [],
          locale: "und",
          schemaVersion: "2",
          template: { key: "research-brief" },
          title,
        },
      },
      {} as never,
    );
    const bytes = result.artifacts?.[0]?.content as Uint8Array;
    const document = await PDFDocument.load(bytes);
    expect(document.getTitle()).toBe(title);
    expect(bytes.byteLength).toBeGreaterThan(4_000);
  }, 15_000);

  test("rejects compressed PNGs with unsafe decoded dimensions", async () => {
    const header = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(100_000, 16);
    header.writeUInt32BE(100_000, 20);
    expect(
      executors()["artifact.pdf_report"]!(
        {
          ...request,
          input: {
            assets: [
              {
                contentBase64: header.toString("base64"),
                contentType: "image/png",
                id: "bomb",
              },
            ],
            blocks: [{ assetId: "bomb", altText: "Unsafe", type: "image" }],
            citations: [],
            schemaVersion: "2",
            template: { key: "executive-report" },
            title: "Unsafe image",
          },
        },
        {} as never,
      ),
    ).rejects.toThrow("dimensions");
  });

  test("bounds aggregate PDF table and chart rendering work", async () => {
    const executor = executors()["artifact.pdf_report"]!;
    const pdfRequest = (blocks: readonly unknown[]) => ({
      ...request,
      input: {
        blocks,
        citations: [],
        schemaVersion: "2",
        template: { key: "data-report" },
        title: "Bounded report",
      },
    });
    expect(
      executor(
        pdfRequest([
          {
            columns: [{ key: "value", label: "Value" }],
            rows: Array.from({ length: 1_001 }, (_, value) => ({ value })),
            type: "table",
          },
        ]) as never,
        {} as never,
      ),
    ).rejects.toThrow("table dimensions");
    expect(
      executor(
        pdfRequest(
          Array.from({ length: 6 }, (_, chart) => ({
            chartType: "line",
            data: Array.from({ length: 1_000 }, (_, value) => ({ value, x: `${chart}-${value}` })),
            series: [{ key: "value", label: "Value" }],
            title: `Chart ${chart}`,
            type: "chart",
            xKey: "x",
          })),
        ) as never,
        {} as never,
      ),
    ).rejects.toThrow("data rows");
  });

  test("neutralizes formula-leading CSV cells", async () => {
    const registry = executors();
    const csv = await registry["artifact.spreadsheet_export"]!(
      {
        ...request,
        input: {
          rows: [{ value: '=HYPERLINK("https://example.com")' }, { value: "\t@SUM(1,2)" }],
        },
        toolName: "artifact.spreadsheet_export",
      },
      {} as never,
    );
    expect(csv.artifacts?.[0]?.content).toBe(
      'value\r\n"\'=HYPERLINK(""https://example.com"")"\r\n"\'\t@SUM(1,2)"\r\n',
    );
  });

  test("preserves negative numeric CSV cells as spreadsheet numbers", async () => {
    const csv = await executors()["artifact.spreadsheet_export"]!(
      {
        ...request,
        input: { rows: [{ value: -42 }, { value: "-42" }] },
        toolName: "artifact.spreadsheet_export",
      },
      {} as never,
    );
    expect(csv.artifacts?.[0]?.content).toBe("value\r\n-42\r\n'-42\r\n");
  });

  test("bounds spreadsheet dimensions before expanding cells", async () => {
    const executor = executors()["artifact.spreadsheet_export"]!;
    expect(
      executor(
        {
          ...request,
          input: {
            columns: Array.from({ length: 251 }, (_, index) => `column-${index}`),
            rows: Array.from({ length: 1_000 }, () => ({})),
          },
          toolName: "artifact.spreadsheet_export",
        },
        {} as never,
      ),
    ).rejects.toThrow("250000 cells");
    expect(
      executor(
        {
          ...request,
          input: { columns: ["duplicate", "duplicate"], rows: [{}] },
          toolName: "artifact.spreadsheet_export",
        },
        {} as never,
      ),
    ).rejects.toThrow("unique");
  });

  test("rejects calendar property injection and emits canonical UTC fields", async () => {
    const executor = executors()["artifact.calendar_event_draft"]!;
    expect(
      executor(
        {
          ...request,
          input: {
            end: "2026-07-29T11:00:00Z",
            start: "2026-07-29T10:00:00Z\r\nATTENDEE:mailto:victim@example.com",
            title: "Unsafe",
          },
          toolName: "artifact.calendar_event_draft",
        },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(TypeError);
    for (const end of ["2026-07-29T10:00:00Z", "2026-07-29T09:59:59Z"]) {
      expect(
        executor(
          {
            ...request,
            input: { end, start: "2026-07-29T10:00:00Z", title: "Invalid interval" },
            toolName: "artifact.calendar_event_draft",
          },
          {} as never,
        ),
      ).rejects.toThrow("after start");
    }
    const result = await executor(
      {
        ...request,
        input: {
          end: "2026-07-29T11:00:00Z",
          start: "2026-07-29T10:00:00Z",
          title: "Safe event",
        },
        toolName: "artifact.calendar_event_draft",
      },
      {} as never,
    );
    expect(result.artifacts?.[0]?.content).toContain(
      "DTSTART:20260729T100000Z\r\nDTEND:20260729T110000Z",
    );
    expect(result.artifacts?.[0]?.content).toContain("DTSTAMP:20260729T100000Z");
    const allDay = await executor(
      {
        ...request,
        input: { end: "2026-07-30", start: "2026-07-29", title: "All day" },
        toolName: "artifact.calendar_event_draft",
      },
      {} as never,
    );
    expect(allDay.artifacts?.[0]?.content).toContain(
      "DTSTART;VALUE=DATE:20260729\r\nDTEND;VALUE=DATE:20260730",
    );
    expect(allDay.artifacts?.[0]?.content).toContain("DTSTAMP:20260729T000000Z");
    const retried = await executor(
      {
        ...request,
        decision: { ...request.decision, toolCallId: "01J00000000000000000000019" as Ulid },
        input: {
          end: "2026-07-29T11:00:00Z",
          start: "2026-07-29T10:00:00Z",
          title: "Safe event",
        },
        toolName: "artifact.calendar_event_draft",
      },
      {} as never,
    );
    expect(retried.artifacts?.[0]?.content).toBe(result.artifacts?.[0]?.content);
  });

  test("refuses a patch without content and an event without start or end", async () => {
    const call = (toolName: string, input: Record<string, unknown>) =>
      executors()[toolName]!({ ...request, input, toolName }, {} as never);

    expect(call("artifact.pr_patch", { fileName: "changes.patch" })).rejects.toThrow(
      "patch, diff, or content is required.",
    );
    expect(call("artifact.calendar_event_draft", { title: "No dates" })).rejects.toThrow(
      "start must be a canonical UTC date or timestamp.",
    );
    expect(
      call("artifact.calendar_event_draft", { start: "2026-07-29", title: "No end" }),
    ).rejects.toThrow("end must be a canonical UTC date or timestamp.");
  });
});
