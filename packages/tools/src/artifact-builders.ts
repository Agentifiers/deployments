import { PDF_REPORT_TOOL_INPUT_SCHEMA, PDF_TEMPLATE_KEYS } from "./pdf-contracts.ts";

import type { ToolAdapterDefinition } from "./types.ts";

export const MAX_SPREADSHEET_ROWS = 10_000;
export const MAX_SPREADSHEET_COLUMNS = 256;
export const MAX_MERMAID_DEFINITION_CHARACTERS = 50_000;

function artifactBuilderTool(
  toolName: string,
  description: string,
  inputSchema?: unknown,
): ToolAdapterDefinition {
  return {
    defaultPolicyAction: "allow",
    description,
    effect: "write",
    egress: "platform",
    execution: { type: "builtin", adapterKey: toolName },
    ...(inputSchema ? { inputSchema } : {}),
    requiredScopes: [],
    status: "active",
    toolName,
  };
}

const CONTENT_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    body: { type: "string" },
    content: { type: "string" },
    description: { type: "string" },
    text: { type: "string" },
    title: { type: "string" },
  },
} as const;

export const artifactBuilderToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  artifactBuilderTool(
    "artifact.mermaid_to_diagram",
    "Convert a Mermaid flowchart into an editable Excalidraw diagram artifact.",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        definition: {
          description: "A Mermaid flowchart or graph definition.",
          maxLength: MAX_MERMAID_DEFINITION_CHARACTERS,
          minLength: 1,
          type: "string",
        },
        fileName: { type: "string", maxLength: 220 },
        fontSize: { type: "integer", maximum: 48, minimum: 12 },
        style: { type: "string", enum: ["clean", "sketchy"] },
        theme: { type: "string", enum: ["light", "dark"] },
        title: { type: "string", maxLength: 200, minLength: 1, pattern: "\\S" },
      },
      required: ["definition"],
    },
  ),
  artifactBuilderTool(
    "artifact.pdf_report",
    "Build a polished, citation-backed PDF report with templates, tables, metrics, images, and static charts.",
    PDF_REPORT_TOOL_INPUT_SCHEMA,
  ),
  artifactBuilderTool(
    "artifact.spreadsheet_export",
    "Build a cited CSV artifact from tabular output.",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        columns: {
          type: "array",
          items: { type: "string", minLength: 1 },
          maxItems: MAX_SPREADSHEET_COLUMNS,
          uniqueItems: true,
        },
        fileName: { type: "string" },
        rows: {
          type: "array",
          items: { type: "object" },
          maxItems: MAX_SPREADSHEET_ROWS,
          minItems: 1,
        },
      },
      required: ["rows"],
    },
  ),
  artifactBuilderTool("artifact.presentation_deck", "Build a cited presentation deck artifact.", {
    type: "object",
    additionalProperties: true,
    properties: {
      fileName: { type: "string" },
      slides: { type: "array" },
      title: { type: "string" },
    },
  }),
  artifactBuilderTool(
    "artifact.ticket_draft",
    "Build a ticket draft artifact from triage context.",
    CONTENT_DRAFT_SCHEMA,
  ),
  artifactBuilderTool(
    "artifact.pr_patch",
    "Build a PR/code patch artifact with diff and test evidence.",
    {
      type: "object",
      additionalProperties: true,
      properties: {
        content: { type: "string" },
        diff: { type: "string" },
        fileName: { type: "string" },
        patch: { type: "string" },
      },
    },
  ),
  artifactBuilderTool(
    "artifact.communication_draft",
    "Build a draft communication artifact for owner review.",
    CONTENT_DRAFT_SCHEMA,
  ),
  artifactBuilderTool(
    "artifact.calendar_event_draft",
    "Build a calendar event draft artifact for owner review.",
    {
      type: "object",
      additionalProperties: true,
      properties: {
        description: { type: "string" },
        end: { type: "string" },
        endsAt: { type: "string" },
        start: { type: "string" },
        startsAt: { type: "string" },
        summary: { type: "string" },
        title: { type: "string" },
        uid: { type: "string" },
      },
    },
  ),
  artifactBuilderTool("artifact.slack_card", "Build a structured Slack result-card artifact.", {
    type: "object",
    additionalProperties: true,
    properties: {},
  }),
  {
    defaultPolicyAction: "allow",
    description: "List the available versioned PDF report templates.",
    effect: "read",
    egress: "platform",
    execution: { type: "builtin", adapterKey: "artifact.pdf_templates.list" },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    requiredScopes: [],
    status: "active",
    toolName: "artifact.pdf_templates.list",
  },
  {
    defaultPolicyAction: "allow",
    description: "Describe one versioned PDF report template before rendering.",
    effect: "read",
    egress: "platform",
    execution: { type: "builtin", adapterKey: "artifact.pdf_templates.get" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { key: { type: "string", enum: [...PDF_TEMPLATE_KEYS] } },
      required: ["key"],
    },
    requiredScopes: [],
    status: "active",
    toolName: "artifact.pdf_templates.get",
  },
] as const;
