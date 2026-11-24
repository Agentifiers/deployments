import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  CoordinateError,
  DEFAULT_COORDINATES,
  resolveCoordinates,
  ROOT_OUTPUT_NAME,
  tableReference,
} from "./coordinates.ts";

const rootOutput = {
  catalog_name: "s3tablescatalog/semantic-events",
  database_name: "semantic_events",
  output_location: "s3://event-analytics-athena-123456789012/results/",
  region: "eu-west-1",
  table_name: "events",
  workgroup_name: "semantic-events",
};

describe("event analytics coordinates", () => {
  it("defaults to the names every install creates and leaves the region to the AWS SDK", () => {
    expect(resolveCoordinates({ env: {}, flags: {} })).toEqual({
      ...DEFAULT_COORDINATES,
      region: undefined,
    });
  });

  it("reads the root's event_analytics_athena output", () => {
    const reads: string[] = [];
    const coordinates = resolveCoordinates({
      env: {},
      flags: { root: "infrastructure/environments/customer" },
      readOutput: (root, name) => {
        reads.push(`${root}#${name}`);
        return rootOutput;
      },
    });
    expect(reads).toEqual([
      `${path.resolve("infrastructure/environments/customer")}#${ROOT_OUTPUT_NAME}`,
    ]);
    expect(coordinates).toEqual({ ...DEFAULT_COORDINATES, region: "eu-west-1" });
  });

  it("prefers flags over environment variables over root outputs", () => {
    const coordinates = resolveCoordinates({
      env: {
        DEPLOYMENTS_AI_EVENT_ANALYTICS_REGION: "us-west-2",
        DEPLOYMENTS_AI_EVENT_ANALYTICS_ROOT: "/roots/install",
        DEPLOYMENTS_AI_EVENT_ANALYTICS_WORKGROUP: "from-env",
      },
      flags: { workgroup: "from-flag" },
      readOutput: () => rootOutput,
    });
    expect(coordinates.region).toBe("us-west-2");
    expect(coordinates.workgroup).toBe("from-flag");
    expect(tableReference(coordinates)).toBe(
      '"s3tablescatalog/semantic-events"."semantic_events"."events"',
    );
  });

  it("explains a root where event analytics is not running", () => {
    expect(() =>
      resolveCoordinates({ env: {}, flags: { root: "/roots/install" }, readOutput: () => null }),
    ).toThrow('Set event_analytics_lifecycle = "running"');
  });

  it("rejects names that could break out of a quoted SQL identifier", () => {
    expect(() =>
      resolveCoordinates({ env: {}, flags: { table: 'events" UNION SELECT "x' } }),
    ).toThrow(CoordinateError);
    expect(() => resolveCoordinates({ env: {}, flags: { region: "us-east-2; rm" } })).toThrow(
      "Invalid event analytics region",
    );
  });
});
