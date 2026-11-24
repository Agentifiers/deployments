import { APP_RELEASE_MAX_DOCUMENT_PATH_BYTES, APP_RELEASE_MAX_DOCUMENTS } from "@deployments-ai/db";
import type { ToolAdapterDefinition } from "./types.ts";

export const APP_TOOL_NAMES = [
  "app.create",
  "app.describe",
  "app.dev_token",
  "app.list",
  "app.migrate",
  "app.promote",
  "app.query",
  "app.release",
  "app.set_publication",
] as const;
export type AppToolName = (typeof APP_TOOL_NAMES)[number];

export const APP_RELEASE_MAX_FILES = 2_000;
export const APP_RELEASE_MAX_BYTES = 50 * 1024 * 1024;
export const APP_QUERY_MAX_ROWS = 200;
export const APP_QUERY_DEFAULT_ROWS = 50;
export const APP_DEV_TOKEN_MINUTES = 15;

const appId = {
  description: "The app id returned by app.create or app.list.",
  pattern: "^[0-9A-HJKMNP-TV-Z]{26}$",
  type: "string",
} as const;

function appTool(
  toolName: AppToolName,
  definition: Omit<ToolAdapterDefinition, "execution" | "requiredScopes" | "status" | "toolName">,
): ToolAdapterDefinition {
  return {
    ...definition,
    ...(definition.effect === "write" ? { providerOutboundMutation: true } : {}),
    egress: "public",
    execution: { adapterKey: toolName, type: "builtin" },
    requiredScopes: [],
    status: "active",
    toolName,
  };
}

export const appToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  appTool("app.create", {
    defaultPolicyAction: "allow",
    description:
      "Create an internal web app for this workspace, owned by this agent: a dedicated Postgres database and a site at https://<slug>.<apps domain>. The slug is permanent and globally unique; it is never released, even after the app is deleted. When this agent already has an app with the slug, returns that app instead, so a later turn can call app.create again with the same slug. Returns the app id, its URL, and next steps. The app starts as a draft that only signed-in members can open: migrations and promotions run without approval until its first promotion or until it is made public, then each needs a human's approval.",
    effect: "write",
    inputSchema: {
      additionalProperties: false,
      properties: {
        name: {
          description: "Human-readable app name shown to members.",
          maxLength: 80,
          minLength: 1,
          type: "string",
        },
        slug: {
          description:
            "3 to 35 lowercase letters, digits, or single hyphens; starts with a letter and ends with a letter or digit. Becomes the app's subdomain.",
          pattern: "^[a-z][a-z0-9-]{1,33}[a-z0-9]$",
          type: "string",
        },
      },
      required: ["name", "slug"],
      type: "object",
    },
  }),
  appTool("app.list", {
    defaultPolicyAction: "allow",
    description:
      "List the apps this agent owns in the current workspace with their ids, slugs, URLs, lifecycle states, live release ids, and publication settings.",
    effect: "read",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
  }),
  appTool("app.describe", {
    defaultPolicyAction: "allow",
    description:
      "Describe one app: its lifecycle, publication settings, releases (newest first), and database schema: tables, columns, constraints, indexes, row-level security policies, the functions the UI can call with their argument and return types, and the migration history. Each function has a `schema`: `api` functions serve signed-in members, and `visitor` functions also serve anonymous visitors once the app is public. Also returns `client`, a generated TypeScript file for the app's `api` and `visitor` functions; save it as src/platform-client.ts in the app's source.",
    effect: "read",
    inputSchema: {
      additionalProperties: false,
      properties: { appId },
      required: ["appId"],
      type: "object",
    },
  }),
  appTool("app.migrate", {
    defaultPolicyAction: "require_approval",
    description:
      "Apply one schema migration to an app's database as a single transaction: tables and views in `public`, the UI's API as SQL functions in `api`, and functions that anonymous visitors of a public app may call in `visitor`. Each `api` or `visitor` function must be `LANGUAGE sql` with a `BEGIN ATOMIC` body; STABLE or IMMUTABLE functions are reads and VOLATILE functions are writes. A function name may exist in only one of the two schemas, and a `visitor` function must not call functions in `public` or `api`. Transaction control, roles and privileges, COPY, LISTEN/NOTIFY, SECURITY DEFINER, and extensions are rejected. Prefer additive changes; Postgres refuses to drop a column a function uses. Put seed data here too. Runs without approval while the app is a draft for members; once the app has a live release or its audience is public, a human must approve. On failure returns the error code, the Postgres message, and the failing statement; nothing is applied.",
    effect: "write",
    inputSchema: {
      additionalProperties: false,
      properties: {
        appId,
        description: {
          description: "One line saying what the migration changes; recorded in the history.",
          maxLength: 500,
          minLength: 1,
          type: "string",
        },
        sql: {
          description: "The migration's SQL statements.",
          maxLength: 100_000,
          minLength: 1,
          type: "string",
        },
      },
      required: ["appId", "description", "sql"],
      type: "object",
    },
  }),
  appTool("app.query", {
    defaultPolicyAction: "allow",
    description: `Run one read-only SQL statement against an app's database as its viewer role and return the column names and types and the rows as text. Writes fail. Returns at most ${APP_QUERY_MAX_ROWS} rows and says when more exist.`,
    effect: "read",
    inputSchema: {
      additionalProperties: false,
      properties: {
        appId,
        maxRows: {
          description: `Row cap; defaults to ${APP_QUERY_DEFAULT_ROWS}.`,
          maximum: APP_QUERY_MAX_ROWS,
          minimum: 1,
          type: "integer",
        },
        sql: { maxLength: 20_000, minLength: 1, type: "string" },
      },
      required: ["appId", "sql"],
      type: "object",
    },
  }),
  appTool("app.dev_token", {
    defaultPolicyAction: "allow",
    description: `Mint a ${APP_DEV_TOKEN_MINUTES}-minute bearer token so a dev server in the sandbox can call the app's API. The token acts as editor while the app is a draft and as viewer once it is live. Returns the token, the app URL, and a Vite \`server.proxy\` entry that forwards /_platform/api to the app with the token. Mint a new token when it expires; never commit it.`,
    effect: "write",
    inputSchema: {
      additionalProperties: false,
      properties: { appId },
      required: ["appId"],
      type: "object",
    },
  }),
  appTool("app.release", {
    defaultPolicyAction: "allow",
    description: `Publish a built site from this thread's sandbox as a new, unpromoted release of an app. \`directory\` is relative to /workspace (for example \`dist\`) and must contain index.html at its root. Build with relative URLs (Vite \`base: "./"\`). At most ${APP_RELEASE_MAX_FILES} files and ${APP_RELEASE_MAX_BYTES / (1024 * 1024)} MiB; symlinks are rejected. Every .html or .htm file is a page: at most ${APP_RELEASE_MAX_DOCUMENTS} pages whose paths total at most ${APP_RELEASE_MAX_DOCUMENT_PATH_BYTES / 1024} KiB. A single-page app serves index.html at every path. When the app's publication serving is static-site, each path serves its own page (/about serves about.html or about/index.html) and a missing page serves the release's 404.html with status 404. SVG, PDF, XML and XHTML files are never served. The serving mode comes from the app's publication settings, not from this tool. Returns the release id; call app.promote to make it live.`,
    effect: "write",
    inputSchema: {
      additionalProperties: false,
      properties: {
        appId,
        directory: {
          description: "Build output directory relative to /workspace, without `..`.",
          maxLength: 512,
          minLength: 1,
          type: "string",
        },
      },
      required: ["appId", "directory"],
      type: "object",
    },
  }),
  appTool("app.promote", {
    defaultPolicyAction: "require_approval",
    description:
      "Make one of an app's releases the live site. Roll back by promoting an earlier release id from app.describe. The first promotion of an app for members runs without approval; once the app is live or its audience is public, a human must approve each promotion.",
    effect: "write",
    inputSchema: {
      additionalProperties: false,
      properties: {
        appId,
        releaseId: {
          description: "A release id returned by app.release or listed by app.describe.",
          pattern: "^[0-9A-HJKMNP-TV-Z]{26}$",
          type: "string",
        },
      },
      required: ["appId", "releaseId"],
      type: "object",
    },
  }),
  appTool("app.set_publication", {
    defaultPolicyAction: "require_approval",
    description:
      "Set who an app serves and how page paths map to files. `audience` is `members` (only signed-in members of the organization; the default) or `public` (anyone on the internet can load the pages and call the app's `visitor` functions without signing in; `api` functions still need a signed-in member). `serving` is `single-page` (every path returns index.html; the default) or `static-site` (each path returns its own HTML file: `/about` serves about.html or about/index.html, and an unknown path serves the release's 404.html with status 404). Send one field or both; a field you leave out keeps its value. Making an app public always needs a human's approval, and so does changing `serving` once the app is live. A call that only sets `audience` to `members` never needs approval. Returns the app with its new settings.",
    effect: "write",
    inputSchema: {
      additionalProperties: false,
      properties: {
        appId,
        audience: { enum: ["members", "public"], type: "string" },
        serving: { enum: ["single-page", "static-site"], type: "string" },
      },
      required: ["appId"],
      type: "object",
    },
  }),
];
