import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CliEnvironment, runCli, USAGE } from "./cli.ts";
import {
  eventColumns,
  eventRows,
  FakeAthena,
  type FakeQueryOutcome,
  fakeClock,
} from "./fake-athena.fixture.ts";

function harness(
  outcome: (sql: string) => FakeQueryOutcome = () => ({ columns: eventColumns, rows: eventRows }),
  overrides: Partial<CliEnvironment> = {},
) {
  const athena = new FakeAthena(outcome);
  const regions: (string | undefined)[] = [];
  const output = { stderr: "", stdout: "" };
  const environment: CliEnvironment = {
    clock: fakeClock(),
    createClient: (region) => {
      regions.push(region);
      return athena;
    },
    env: {},
    stderr: (text) => {
      output.stderr += text;
    },
    stdout: (text) => {
      output.stdout += text;
    },
    ...overrides,
  };
  return { athena, environment, output, regions };
}

describe("bun run events", () => {
  it("prints recent events as a table with a query summary", async () => {
    const { athena, environment, output, regions } = harness();
    expect(
      await runCli(["recent", "--region", "us-east-2", "--type", "agent.created"], environment),
    ).toBe(0);
    expect(regions).toEqual(["us-east-2"]);
    expect(athena.started[0]?.WorkGroup).toBe("semantic-events");
    expect(athena.started[0]?.QueryString).toContain("AND event_type = 'agent.created'");
    expect(athena.started[0]?.QueryString).toContain("LIMIT 51");
    const [header, rule, first] = output.stdout.split("\n");
    expect(header).toBe(
      "event_id                    event_type     organization_id             aggregate_version  occurred_at               trace_id",
    );
    expect(rule?.startsWith("--------------------------  -------------")).toBe(true);
    expect(first).toBe(
      "01JA0000000000000000000010  agent.created  01JA0000000000000000000001  1                  2026-10-16T11:59:00.000Z",
    );
    expect(output.stdout).toContain("2 rows · scanned 1.00 MiB · query query-1");
    expect(output.stderr).toBe("");
  });

  it("prints JSON with --json and passes the payload and limit flags through", async () => {
    const { athena, environment, output } = harness();
    expect(
      await runCli(["recent", "--json", "--payload", "--limit", "5", "--since", "7d"], environment),
    ).toBe(0);
    expect(athena.started[0]?.QueryString).toContain("payload_json");
    expect(athena.started[0]?.QueryString).toContain("LIMIT 6");
    expect(JSON.parse(output.stdout)).toMatchObject({ row_count: 2, truncated: false });
  });

  it("counts events by type", async () => {
    const { athena, environment, output } = harness(() => ({
      columns: [
        { name: "event_type", type: "varchar" },
        { name: "event_count", type: "bigint" },
      ],
      rows: [["agent.created", "4"]],
    }));
    expect(
      await runCli(["counts", "--organization", "01JA0000000000000000000001"], environment),
    ).toBe(0);
    expect(athena.started[0]?.QueryString).toContain("count(DISTINCT event_id)");
    expect(output.stdout).toContain("agent.created  4");
    expect(output.stdout).toContain("1 row ·");
  });

  it("runs guarded SQL from an argument or a file", async () => {
    const { athena, environment } = harness();
    expect(
      await runCli(["sql", "SELECT event_type FROM events", "--max-rows", "10"], environment),
    ).toBe(0);
    expect(athena.started[0]?.QueryString).toBe("SELECT event_type FROM events\nLIMIT 11");

    const directory = await mkdtemp(path.join(tmpdir(), "event-analytics-cli-"));
    try {
      const file = path.join(directory, "query.sql");
      await writeFile(file, "WITH t AS (SELECT 1 AS n) SELECT n FROM t LIMIT 3;\n");
      expect(await runCli(["sql", "--file", file], environment)).toBe(0);
      expect(athena.started[1]?.QueryString).toBe(
        "WITH t AS (SELECT 1 AS n) SELECT n FROM t LIMIT 3",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("refuses writes before reaching Athena", async () => {
    const { athena, environment, output } = harness();
    expect(await runCli(["sql", "DELETE FROM events"], environment)).toBe(1);
    expect(output.stderr).toBe("error: Only SELECT and WITH queries are allowed.\n");
    expect(athena.commands).toHaveLength(0);
  });

  it("reads the Athena coordinates from an OpenTofu root", async () => {
    const { athena, environment, regions } = harness(undefined, {
      readOutput: () => ({
        catalog_name: "s3tablescatalog/semantic-events",
        database_name: "semantic_events",
        region: "ap-southeast-2",
        table_name: "events",
        workgroup_name: "semantic-events",
      }),
    });
    expect(
      await runCli(["counts", "--root", "infrastructure/environments/customer"], environment),
    ).toBe(0);
    expect(regions).toEqual(["ap-southeast-2"]);
    expect(athena.started).toHaveLength(1);
  });

  it("shows the schema without querying", async () => {
    const { athena, environment, output } = harness();
    expect(await runCli(["schema"], environment)).toBe(0);
    expect(output.stdout).toContain("payload_json");
    expect(output.stdout).toContain("platform operators only");
    expect(athena.commands).toHaveLength(0);
  });

  it("prints usage for help and fails on a missing or unknown command", async () => {
    const help = harness();
    expect(await runCli(["help"], help.environment)).toBe(0);
    expect(help.output.stdout).toBe(USAGE);
    const none = harness();
    expect(await runCli([], none.environment)).toBe(1);
    const unknown = harness();
    expect(await runCli(["drop"], unknown.environment)).toBe(1);
    expect(unknown.output.stderr).toContain("Unknown command drop");
    const flag = harness();
    expect(await runCli(["recent", "--organisation", "x"], flag.environment)).toBe(1);
    const limit = harness();
    expect(await runCli(["recent", "--limit", "lots"], limit.environment)).toBe(1);
    expect(limit.athena.commands).toHaveLength(0);
  });
});
