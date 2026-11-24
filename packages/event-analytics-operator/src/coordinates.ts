import path from "node:path";
import { Schema } from "effect";

/** Where the semantic event log lives. Every install uses these names unless a root overrides them. */
export const DEFAULT_COORDINATES = {
  catalog: "s3tablescatalog/semantic-events",
  database: "semantic_events",
  table: "events",
  workgroup: "semantic-events",
} as const;

/** The root output the operator tooling reads when `--root` names an OpenTofu root. */
export const ROOT_OUTPUT_NAME = "event_analytics_athena";

const ENV_PREFIX = "DEPLOYMENTS_AI_EVENT_ANALYTICS_";

export interface EventAnalyticsCoordinates {
  readonly catalog: string;
  readonly database: string;
  /** Undefined lets the AWS SDK resolve the region from the operator's profile or environment. */
  readonly region: string | undefined;
  readonly table: string;
  readonly workgroup: string;
}

export interface CoordinateFlags {
  readonly catalog?: string | undefined;
  readonly database?: string | undefined;
  readonly region?: string | undefined;
  readonly root?: string | undefined;
  readonly table?: string | undefined;
  readonly workgroup?: string | undefined;
}

/** `parseArgs` options both entry points accept for the coordinates. */
export const coordinateOptions = {
  catalog: { type: "string" },
  database: { type: "string" },
  region: { type: "string" },
  root: { type: "string" },
  table: { type: "string" },
  workgroup: { type: "string" },
} as const satisfies Record<keyof CoordinateFlags, { readonly type: "string" }>;

const RootAthenaOutput = Schema.NullOr(
  Schema.Struct({
    catalog_name: Schema.String,
    database_name: Schema.String,
    region: Schema.String,
    table_name: Schema.String,
    workgroup_name: Schema.String,
  }),
);

const decodeRootAthenaOutput = Schema.decodeUnknownSync(RootAthenaOutput);

const identifierRules = {
  catalog: /^[A-Za-z0-9_-]{1,128}(?:\/[A-Za-z0-9._-]{1,128})?$/u,
  database: /^[A-Za-z0-9_]{1,255}$/u,
  region: /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/u,
  table: /^[A-Za-z0-9_]{1,255}$/u,
  workgroup: /^[A-Za-z0-9._-]{1,128}$/u,
} as const;

export class CoordinateError extends Error {
  override readonly name = "CoordinateError";
}

function checked(name: keyof typeof identifierRules, value: string) {
  if (!identifierRules[name].test(value)) {
    throw new CoordinateError(`Invalid event analytics ${name}: ${JSON.stringify(value)}.`);
  }
  return value;
}

function present(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Reads one output of an initialized OpenTofu root with `tofu output -json`. */
export function readTofuOutput(root: string, name: string): unknown {
  const result = Bun.spawnSync(["tofu", `-chdir=${root}`, "output", "-json", name], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || `exit ${String(result.exitCode)}`;
    throw new CoordinateError(`tofu output ${name} failed in ${root}: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout.toString()) as unknown;
  } catch (cause) {
    throw new CoordinateError(`tofu output ${name} in ${root} did not return valid JSON.`, {
      cause,
    });
  }
}

function rootCoordinates(root: string, readOutput: (root: string, name: string) => unknown) {
  const output = decodeRootAthenaOutput(readOutput(root, ROOT_OUTPUT_NAME));
  if (output === null) {
    throw new CoordinateError(
      `${root} reports ${ROOT_OUTPUT_NAME} = null: event analytics is not running there. Set event_analytics_lifecycle = "running" and deploy.`,
    );
  }
  return {
    catalog: output.catalog_name,
    database: output.database_name,
    region: output.region,
    table: output.table_name,
    workgroup: output.workgroup_name,
  };
}

/**
 * Resolves the Athena coordinates from flags, then `DEPLOYMENTS_AI_EVENT_ANALYTICS_*` variables,
 * then the `event_analytics_athena` output of the OpenTofu root, then the install defaults.
 */
export function resolveCoordinates(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly flags: CoordinateFlags;
  readonly readOutput?: (root: string, name: string) => unknown;
}): EventAnalyticsCoordinates {
  const setting = (name: keyof CoordinateFlags) =>
    present(input.flags[name]) ?? present(input.env[`${ENV_PREFIX}${name.toUpperCase()}`]);
  const root = setting("root");
  const fromRoot = root
    ? rootCoordinates(path.resolve(root), input.readOutput ?? readTofuOutput)
    : undefined;
  const region = setting("region") ?? fromRoot?.region;
  return {
    catalog: checked(
      "catalog",
      setting("catalog") ?? fromRoot?.catalog ?? DEFAULT_COORDINATES.catalog,
    ),
    database: checked(
      "database",
      setting("database") ?? fromRoot?.database ?? DEFAULT_COORDINATES.database,
    ),
    region: region === undefined ? undefined : checked("region", region),
    table: checked("table", setting("table") ?? fromRoot?.table ?? DEFAULT_COORDINATES.table),
    workgroup: checked(
      "workgroup",
      setting("workgroup") ?? fromRoot?.workgroup ?? DEFAULT_COORDINATES.workgroup,
    ),
  };
}

/** The fully qualified, quoted Athena reference to the semantic event table. */
export function tableReference(coordinates: EventAnalyticsCoordinates) {
  return `"${coordinates.catalog}"."${coordinates.database}"."${coordinates.table}"`;
}
