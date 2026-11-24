import { PublicId, ResourceName, ScopeName } from "@deployments-ai/api-contract";
import { Ulid } from "@deployments-ai/db";
import { normalizeEmail, validatePasswordInput } from "@deployments-ai/identity";
import { Schema } from "effect";
import { probePath } from "./api-key-plan.ts";

const identityUsage = `  identity --principal-id <ulid> --username <email> [--password-secret <parameter>] [--rotate]
      Ensure a human platform administrator can sign in with a password. Creates the
      principal and its login when missing. Writes nothing when the stored password
      already verifies; otherwise rotates the login (new credential version, signs out
      every session). --password-secret names the SecureString parameter that holds the
      password and is created with a generated password when missing. Without it, the
      password comes from DEPLOYMENTS_OPERATOR_PASSWORD. --rotate writes a new generated
      password to the parameter first, then rotates the login to it; it needs
      --password-secret.`;

const tokenUsage = `  token --api-url <origin> --issuer <origin> --username <email> [--password-secret <parameter>] [--format token|json]
      Sign in as the identity and approve a device authorization to mint a short-lived
      platform bearer token. Prints the token, or {"token","expiresAt"} with --format json.
      The password comes from --password-secret or DEPLOYMENTS_OPERATOR_PASSWORD.`;

const apiKeyUsage = `  api-key --api-url <origin> --org <ulid> --project <ulid> --env <ulid> --name <name>
          --scopes <scope,...> --secret <parameter> [--rotate]
          [--issuer <origin> --username <email> [--password-secret <parameter>]]
      Ensure a service account and an API key, both named --name with exactly --scopes,
      in one environment, and keep the key in the SecureString parameter (created when
      missing). Keeps the stored key while it is that service account's active key with
      the same scopes and still authenticates. Otherwise, or with --rotate, issues a new
      key, checks it, writes it to the parameter, then revokes the replaced key. The caller
      authenticates with DEPLOYMENTS_API_KEY, or with a token minted as in \`token\`
      from --issuer, --username, and the password.`;

const footer = `Passwords and API keys never appear in flags or output; only token prints the bearer
token it mints. AWS credentials and region come from the standard AWS chain. identity
writes the DynamoDB control, identity, and events tables named by
DEPLOYMENTS_AI_<TABLE>_TABLE (default: the bare table name). See
apps/docs/content/docs/operate/platform-credentials.mdx.`;

export const commandUsage = {
  "api-key": apiKeyUsage,
  identity: identityUsage,
  token: tokenUsage,
} as const;

export type CommandName = keyof typeof commandUsage;

export function usage(command?: CommandName) {
  const body = command
    ? commandUsage[command]
    : [identityUsage, tokenUsage, apiKeyUsage].join("\n");
  return `Usage: bun run credential -- ${command ?? "<command>"} [flags]

${command ? "Command" : "Commands"}:
${body}

${footer}`;
}

export type PasswordSource =
  | { readonly kind: "environment"; readonly password: string }
  | { readonly kind: "secret"; readonly secretId: string };

export interface IdentityLogin {
  readonly issuer: string;
  readonly password: PasswordSource;
  readonly username: string;
}

export interface Tenancy {
  readonly environmentId: PublicId;
  readonly organizationId: PublicId;
  readonly projectId: PublicId;
}

export type Bearer =
  | { readonly kind: "api-key"; readonly key: string }
  | { readonly kind: "identity"; readonly login: IdentityLogin };

export type CliCommand =
  | { readonly kind: "help"; readonly command: CommandName | undefined }
  | {
      readonly kind: "identity";
      readonly password: PasswordSource;
      readonly principalId: Ulid;
      readonly rotate: boolean;
      readonly username: string;
    }
  | {
      readonly apiUrl: string;
      readonly format: "json" | "token";
      readonly kind: "token";
      readonly login: IdentityLogin;
    }
  | {
      readonly apiUrl: string;
      readonly bearer: Bearer;
      readonly kind: "api-key";
      readonly name: string;
      readonly rotate: boolean;
      readonly scopes: readonly [string, ...string[]];
      readonly secretId: string;
      readonly tenancy: Tenancy;
    };

export type Environment = Readonly<Record<string, string | undefined>>;

const valueFlags = [
  "--api-url",
  "--env",
  "--format",
  "--issuer",
  "--name",
  "--org",
  "--password-secret",
  "--principal-id",
  "--project",
  "--scopes",
  "--secret",
  "--username",
] as const;
type ValueFlag = (typeof valueFlags)[number];
type FlagValues = Partial<Record<ValueFlag, string>>;

function isValueFlag(flag: string): flag is ValueFlag {
  return (valueFlags as readonly string[]).includes(flag);
}

function parseFlags(arguments_: readonly string[], allowed: readonly (ValueFlag | "--rotate")[]) {
  const values: FlagValues = {};
  let rotate = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index] ?? "";
    if (!(allowed as readonly string[]).includes(flag)) {
      throw new Error(`Unexpected argument ${flag}. Run with --help for usage.`);
    }
    if (flag === "--rotate") {
      rotate = true;
      continue;
    }
    if (!isValueFlag(flag)) throw new Error(`Unexpected argument ${flag}.`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    if (values[flag] !== undefined) throw new Error(`${flag} was given twice.`);
    values[flag] = value;
    index += 1;
  }
  return { rotate, values };
}

function requiredValue(values: FlagValues, flag: ValueFlag, placeholder: string) {
  const value = values[flag]?.trim();
  if (!value) throw new Error(`${flag} <${placeholder}> is required.`);
  return value;
}

const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, "[::1]": true, localhost: true };

function origin(values: FlagValues, flag: "--api-url" | "--issuer") {
  const value = requiredValue(values, flag, "origin");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${flag} must be an origin such as https://api.example.com.`);
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS[url.hostname]);
  if (!secure || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      `${flag} must be an https origin without credentials, path, query, or fragment.`,
    );
  }
  return url.origin;
}

function username(values: FlagValues) {
  const value = requiredValue(values, "--username", "email");
  try {
    return normalizeEmail(value);
  } catch {
    throw new Error("--username must be an email address.");
  }
}

function principalId(values: FlagValues) {
  const value = requiredValue(values, "--principal-id", "ulid");
  if (!Schema.is(Ulid)(value)) {
    throw new Error("--principal-id must be a canonical uppercase 26-character ULID.");
  }
  return value;
}

function publicId(values: FlagValues, flag: "--env" | "--org" | "--project") {
  const value = requiredValue(values, flag, "ulid");
  if (!Schema.is(PublicId)(value)) {
    throw new Error(`${flag} must be a canonical uppercase 26-character ULID.`);
  }
  return value;
}

const PARAMETER_NAME = /^(?:\/[A-Za-z0-9_.-]+){2,15}$/u;

function secretId(values: FlagValues, flag: "--password-secret" | "--secret") {
  const value = requiredValue(values, flag, "parameter");
  if (!PARAMETER_NAME.test(value) || value.length > 1011) {
    throw new Error(`${flag} must be a Parameter Store path such as /operators/example/password.`);
  }
  return value;
}

function resourceName(values: FlagValues) {
  const value = requiredValue(values, "--name", "name");
  if (!Schema.is(ResourceName)(value)) {
    throw new Error("--name must be 1 to 120 characters without surrounding whitespace.");
  }
  return value;
}

function scopes(values: FlagValues): readonly [string, ...string[]] {
  const [first, ...rest] = requiredValue(values, "--scopes", "scope,...")
    .split(",")
    .map((scope) => scope.trim());
  const list: readonly [string, ...string[]] = [first ?? "", ...rest];
  const invalid = list.find((scope): boolean => !Schema.is(ScopeName)(scope));
  if (invalid !== undefined) {
    throw new Error(
      invalid
        ? `--scopes contains an invalid scope "${invalid}".`
        : "--scopes must not contain empty entries.",
    );
  }
  if (new Set(list).size !== list.length) throw new Error("--scopes must not repeat a scope.");
  if (!probePath(list)) {
    throw new Error(
      "--scopes must include a read scope the key can be checked with: approvals:read, agents:read, channels:read, workspaces:read, tools:read, schedules:read, or webhooks:read.",
    );
  }
  return list;
}

function passwordSource(values: FlagValues, environment: Environment): PasswordSource {
  if (values["--password-secret"] !== undefined) {
    return { kind: "secret", secretId: secretId(values, "--password-secret") };
  }
  const password = environment.DEPLOYMENTS_OPERATOR_PASSWORD;
  if (!password) {
    throw new Error("Pass --password-secret <parameter> or set DEPLOYMENTS_OPERATOR_PASSWORD.");
  }
  try {
    validatePasswordInput(password);
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`DEPLOYMENTS_OPERATOR_PASSWORD is not a usable password.${reason}`);
  }
  return { kind: "environment", password };
}

function identityLogin(values: FlagValues, environment: Environment): IdentityLogin {
  return {
    issuer: origin(values, "--issuer"),
    password: passwordSource(values, environment),
    username: username(values),
  };
}

function bearer(values: FlagValues, environment: Environment): Bearer {
  const key = environment.DEPLOYMENTS_API_KEY?.trim();
  const loginFlags = (["--issuer", "--username", "--password-secret"] as const).filter(
    (flag) => values[flag] !== undefined,
  );
  if (key) {
    if (loginFlags.length > 0) {
      throw new Error(
        `DEPLOYMENTS_API_KEY is set, so ${loginFlags.join(", ")} would be ignored; use one bearer source.`,
      );
    }
    return { key, kind: "api-key" };
  }
  if (values["--issuer"] === undefined && values["--username"] === undefined) {
    throw new Error(
      "api-key needs a bearer: set DEPLOYMENTS_API_KEY, or pass --issuer and --username to mint one.",
    );
  }
  return { kind: "identity", login: identityLogin(values, environment) };
}

function isCommandName(value: string | undefined): value is CommandName {
  return value !== undefined && Object.hasOwn(commandUsage, value);
}

/** Parses argv into a validated command without touching AWS or the network. */
export function parseCli(argv: readonly string[], environment: Environment): CliCommand {
  const [first, ...rest] = argv;
  if (first === undefined || first === "help" || argv.includes("--help") || argv.includes("-h")) {
    const topic = first === "help" ? rest[0] : first;
    return { command: isCommandName(topic) ? topic : undefined, kind: "help" };
  }
  switch (first) {
    case "identity": {
      const { rotate, values } = parseFlags(rest, [
        "--password-secret",
        "--principal-id",
        "--rotate",
        "--username",
      ]);
      const id = principalId(values);
      const email = username(values);
      if (rotate && values["--password-secret"] === undefined) {
        throw new Error(
          "--rotate needs --password-secret; to rotate DEPLOYMENTS_OPERATOR_PASSWORD, change it and run identity again.",
        );
      }
      return {
        kind: "identity",
        password: passwordSource(values, environment),
        principalId: id,
        rotate,
        username: email,
      };
    }
    case "token": {
      const { values } = parseFlags(rest, [
        "--api-url",
        "--format",
        "--issuer",
        "--password-secret",
        "--username",
      ]);
      const format = values["--format"] ?? "token";
      if (format !== "token" && format !== "json") {
        throw new Error("--format must be token or json.");
      }
      return {
        apiUrl: origin(values, "--api-url"),
        format,
        kind: "token",
        login: identityLogin(values, environment),
      };
    }
    case "api-key": {
      const { rotate, values } = parseFlags(rest, [
        "--api-url",
        "--env",
        "--issuer",
        "--name",
        "--org",
        "--password-secret",
        "--project",
        "--rotate",
        "--scopes",
        "--secret",
        "--username",
      ]);
      return {
        apiUrl: origin(values, "--api-url"),
        bearer: bearer(values, environment),
        kind: "api-key",
        name: resourceName(values),
        rotate,
        scopes: scopes(values),
        secretId: secretId(values, "--secret"),
        tenancy: {
          environmentId: publicId(values, "--env"),
          organizationId: publicId(values, "--org"),
          projectId: publicId(values, "--project"),
        },
      };
    }
    default:
      throw new Error(`Unknown command ${first}. Run with --help for usage.`);
  }
}
