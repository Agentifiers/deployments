import type { PlatformRequest, PlatformResponse, PlatformSdk } from "@agentifiers/deployments-sdk";
import type { ArgDef } from "citty";
export type ContextScope = "environment" | "none" | "organization" | "project" | "tenant";
export type OutputKind = "action" | "detail" | "list" | "stream";
type ArgumentTarget = "body" | "control" | "path" | "query";

export interface CommandArgument {
  readonly definition: ArgDef;
  readonly field?: string;
  readonly target: ArgumentTarget;
  readonly bodyField?: string;
  /** Collect every occurrence of the flag into an array instead of keeping only the last value. */
  readonly repeatable?: true;
  readonly transform?: "csv" | "email-end-user-id" | "json" | "negated-boolean" | "null" | "number";
}

export interface ActionSpec {
  readonly summary: string;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly path: string;
  readonly scope: ContextScope;
  readonly output: OutputKind;
  readonly listField?: string;
  readonly columns?: readonly string[];
  readonly pagination?:
    | false
    | {
        readonly limitField: string;
        readonly maxLimit?: number;
        readonly target: "body" | "query";
      };
  readonly args?: Readonly<Record<string, CommandArgument>>;
  readonly aliases?: readonly string[];
  readonly idempotent?: boolean;
  readonly requiresExplicitIdempotencyKey?: boolean;
  readonly destructive?: boolean;
  readonly sensitiveOutput?: boolean;
  readonly sensitiveOutputFields?: readonly string[];
  readonly secretInputs?: readonly SecretInputSpec[];
  readonly fileInputs?: readonly FileInputSpec[];
  readonly fixedBody?: Readonly<Record<string, unknown>>;
  readonly rawFileInput?: RawFileInputSpec;
  /** Turns the flat body the arguments produced into the route's request shape; throws `CliError`. */
  readonly shapeBody?: (body: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  /** Sends the built request for an action that spans several calls, in place of one `request`. */
  readonly send?: (sdk: PlatformSdk, request: PlatformRequest) => Promise<PlatformResponse>;
}

export interface RawFileInputSpec {
  readonly argument: string;
  readonly contentTypeArgument: string;
  readonly maximumBytes: number;
}

export interface SecretInputSpec {
  readonly directArgument: string;
  readonly environmentArgument: string;
  readonly fileArgument: string;
  readonly format?: "json" | "json-or-text" | "text";
  readonly bodyField: string;
  readonly required: boolean;
  readonly optionalWhen?: {
    readonly argument: string;
    readonly equals: string;
  };
}

export interface FileInputSpec {
  readonly argument: string;
  readonly bodyField: string;
  readonly format: "json" | "text";
  readonly exclusiveWith?: string;
  readonly required: boolean;
}

interface ResourceSpec {
  readonly summary: string;
  /** Nests the resource under a shared top-level command: `deployments <name> <command> <action>`. */
  readonly namespace?: { readonly name: string; readonly command: string };
  readonly actions: Readonly<Record<string, ActionSpec>>;
}

export type CommandCatalog = Readonly<Record<string, ResourceSpec>>;

export interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly isInteractive: boolean;
}

export interface ProfileConfig {
  readonly apiUrl: string;
  readonly apiKey?: string;
  readonly apiKeyExpiresAt?: string;
  readonly refreshToken?: string;
  readonly credentialState?: "active" | "refresh-in-progress" | "reauthentication-required";
  readonly refreshAttemptId?: string;
  readonly refreshStartedAt?: string;
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly workspaceId?: string;
  readonly mock?: boolean;
}

export interface CliConfig {
  readonly version: 1;
  readonly currentProfile: string;
  readonly profiles: Readonly<Record<string, ProfileConfig>>;
}

export interface ResolvedCliContext {
  readonly profileName: string;
  readonly apiUrl: string;
  readonly apiKey?: string;
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly workspaceId?: string;
  readonly mock: boolean;
}
