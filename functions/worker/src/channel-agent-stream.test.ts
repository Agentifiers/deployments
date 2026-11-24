import { describe, expect, test } from "bun:test";
import type { DynamoDatabaseService } from "@deployments-ai/db";
import { fixtures, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";
import { ensureChannelAgentStreams } from "./channel-agent-stream.ts";
import { slackFixture } from "./slack-agent-stream.fixture.ts";
import { teamsFixture } from "./teams-agent-stream.fixture.ts";

/** Records the sort key of every read so tests can assert which records were consulted. */
function countingReads(database: DynamoDatabaseService) {
  const reads: string[] = [];
  return {
    database: {
      ...database,
      getRecord: (...input: Parameters<DynamoDatabaseService["getRecord"]>) => {
        reads.push(input[1].sk);
        return database.getRecord(...input);
      },
    },
    readsOf: (prefix: string) => reads.filter((sk) => sk.startsWith(`${prefix}#`)).length,
  };
}

const unexpectedTeamsClient = {
  sendActivity: async () => {
    throw new Error("Teams must not be called.");
  },
  updateActivity: async () => {
    throw new Error("Teams must not be called.");
  },
};

describe("channel agent stream initialization", () => {
  test("consults no provider stream for a run that did not arrive through channel ingress", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([fixture.thread, fixture.userMessage, fixture.run]);
    const counted = countingReads(memory.database);
    const dependencies = {
      ...workerDependencies(counted.database).dependencies,
      readChannelCredential: async () => ({}),
      teamsAgentStream: unexpectedTeamsClient,
    };

    await ensureChannelAgentStreams(dependencies, fixture.run, fixture.userMessage);

    expect(counted.readsOf("SLACK-AGENT-STREAM")).toBe(0);
    expect(counted.readsOf("TEAMS-AGENT-STREAM")).toBe(0);
    expect(counted.readsOf("CHANNEL-BINDING")).toBe(0);
  });

  test("starts a Slack run's stream without consulting Teams", async () => {
    const test = slackFixture();
    const counted = countingReads(test.dependencies.database);

    await ensureChannelAgentStreams(
      { ...test.dependencies, database: counted.database, teamsAgentStream: unexpectedTeamsClient },
      test.run,
      test.userMessage,
    );

    expect(test.calls.map((call) => call.method)).toEqual(["start"]);
    expect(counted.readsOf("TEAMS-AGENT-STREAM")).toBe(0);
    expect(counted.readsOf("MESSAGE")).toBe(0);
  });

  test("starts a Teams run's stream without consulting Slack", async () => {
    const test = teamsFixture();
    const counted = countingReads(test.dependencies.database);

    await ensureChannelAgentStreams(
      {
        ...test.dependencies,
        database: counted.database,
        slackAgentStream: {
          append: async () => undefined,
          start: async () => {
            throw new Error("Slack must not be called.");
          },
          stop: async () => undefined,
          update: async () => undefined,
        },
      },
      test.run,
      test.userMessage,
    );

    expect(test.calls).toHaveLength(1);
    expect(counted.readsOf("SLACK-AGENT-STREAM")).toBe(0);
    expect(counted.readsOf("MESSAGE")).toBe(0);
  });
});
