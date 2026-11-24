import { Schema } from "effect";
import { parseArgs } from "node:util";
import { runCommand, singleLine, type Environment } from "./platform-deploy/process.ts";

const RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288,
  3653,
] as const;
const USAGE =
  "Usage: bun scripts/log-retention-audit.ts [--region <region>] [--apply --days <retention-days>]";

const LogGroupPage = Schema.Struct({
  logGroups: Schema.Array(
    Schema.Struct({
      logGroupName: Schema.String,
      retentionInDays: Schema.optionalKey(Schema.Number),
      storedBytes: Schema.optionalKey(Schema.Number),
    }),
  ),
  nextToken: Schema.optionalKey(Schema.String),
});
const decodeLogGroupPage = Schema.decodeUnknownSync(LogGroupPage);
export type LogGroup = (typeof LogGroupPage.Type)["logGroups"][number];

export type AuditCommand =
  | { readonly kind: "report"; readonly region: string }
  | { readonly kind: "apply"; readonly days: number; readonly region: string };

export function parseAuditCommand(args: readonly string[], environment: Environment): AuditCommand {
  const { values } = parseArgs({
    args: [...args],
    options: {
      apply: { type: "boolean" },
      days: { type: "string" },
      region: { type: "string" },
    },
  });
  const region = (
    values.region ??
    environment.AWS_REGION ??
    environment.AWS_DEFAULT_REGION
  )?.trim();
  if (!region) throw new Error(`A region is required. ${USAGE}`);
  if (!values.apply) {
    if (values.days !== undefined) throw new Error(`--days only applies with --apply. ${USAGE}`);
    return { kind: "report", region };
  }
  const days = Number(values.days);
  if (!RETENTION_DAYS.some((allowed) => allowed === days)) {
    throw new Error(
      `--apply needs --days set to a CloudWatch Logs retention value (${RETENTION_DAYS.join(", ")}). ${USAGE}`,
    );
  }
  return { days, kind: "apply", region };
}

export function unretainedLogGroups(groups: readonly LogGroup[]) {
  return groups
    .filter((group) => group.retentionInDays === undefined)
    .toSorted((left, right) => left.logGroupName.localeCompare(right.logGroupName));
}

async function listLogGroups(region: string) {
  const groups: LogGroup[] = [];
  let nextToken: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop -- Pagination must follow the service cursor.
    const output = await runCommand([
      "aws",
      "logs",
      "describe-log-groups",
      "--region",
      region,
      "--no-paginate",
      "--limit",
      "50",
      "--output",
      "json",
      ...(nextToken ? ["--next-token", nextToken] : []),
    ]);
    const page = decodeLogGroupPage(JSON.parse(output));
    groups.push(...page.logGroups);
    nextToken = page.nextToken;
  } while (nextToken);
  return groups;
}

async function main(command: AuditCommand) {
  const unretained = unretainedLogGroups(await listLogGroups(command.region));
  for (const group of unretained) {
    process.stdout.write(`${group.logGroupName}\t${group.storedBytes ?? 0} bytes\n`);
  }
  if (command.kind === "report") {
    process.stderr.write(`${unretained.length} log group(s) in ${command.region} never expire.\n`);
    if (unretained.length > 0) process.exitCode = 1;
    return;
  }
  for (const group of unretained) {
    // eslint-disable-next-line no-await-in-loop -- Sequential writes keep CloudWatch throttling out of the way.
    await runCommand([
      "aws",
      "logs",
      "put-retention-policy",
      "--region",
      command.region,
      "--log-group-name",
      group.logGroupName,
      "--retention-in-days",
      String(command.days),
    ]);
  }
  process.stderr.write(
    `Set ${command.days}-day retention on ${unretained.length} log group(s) in ${command.region}.\n`,
  );
}

if (import.meta.main) {
  try {
    await main(parseAuditCommand(process.argv.slice(2), process.env));
  } catch (error) {
    process.stderr.write(`${singleLine(error)}\n`);
    process.exitCode = 1;
  }
}
