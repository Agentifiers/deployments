import { appendFileSync } from "node:fs";
import { SystemInstallationResponse, Timestamp } from "@deployments-ai/api-contract";
import type { Installation } from "@deployments-ai/db";
import { Schema } from "effect";
import { deployStages, type DeployStageId, type DeployStageRunner } from "./deploy-stages.ts";
import { describeError } from "./process.ts";

const { observability: _observability, ...recordedInstallationFields } =
  SystemInstallationResponse.fields;
const RecordedInstallation = Schema.Struct(recordedInstallationFields);
const decodeRecordedInstallation = Schema.decodeUnknownSync(RecordedInstallation);

const Sha256Hex = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));
const CommitSha = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/u)));
const Stage = Schema.Literals(deployStages.map(({ id }) => id));
const envelope = { at: Timestamp, version: Schema.Literal(1) };

export const DeployEvent = Schema.Union([
  Schema.Struct({
    ...envelope,
    releaseManifestSha256: Sha256Hex,
    sourceCommit: CommitSha,
    target: Schema.String,
    type: Schema.Literal("started"),
  }),
  Schema.Struct({ ...envelope, stage: Stage, type: Schema.Literal("stage-started") }),
  Schema.Struct({
    ...envelope,
    detail: Schema.optionalKey(Schema.String),
    stage: Stage,
    type: Schema.Literal("stage-succeeded"),
  }),
  Schema.Struct({
    ...envelope,
    message: Schema.String,
    stage: Stage,
    type: Schema.Literal("stage-failed"),
  }),
  Schema.Struct({ ...envelope, message: Schema.String, type: Schema.Literal("preflight-failed") }),
  Schema.Struct({
    ...envelope,
    installation: RecordedInstallation,
    type: Schema.Literal("recorded"),
  }),
  Schema.Struct({
    ...envelope,
    outcome: Schema.Literals(["failed", "succeeded"]),
    type: Schema.Literal("finished"),
  }),
]);
export type DeployEvent = typeof DeployEvent.Type;

type WithoutEnvelope<Event> = Event extends unknown ? Omit<Event, "at" | "version"> : never;
export type DeployEventBody = WithoutEnvelope<DeployEvent>;
export type DeployEventSink = (event: DeployEventBody) => void;

export function deployEventFile(path: string, now: () => Date = () => new Date()): DeployEventSink {
  return ({ type, ...fields }) => {
    appendFileSync(
      path,
      `${JSON.stringify({ version: 1, type, at: now().toISOString(), ...fields })}\n`,
    );
  };
}

export interface DeployRun {
  readonly failOnce: (error: unknown) => void;
  readonly runStage: DeployStageRunner;
  readonly start: (started: Omit<Extract<DeployEventBody, { type: "started" }>, "type">) => void;
  readonly succeed: (installation: Installation) => void;
}

export function deployRun(events: DeployEventSink): DeployRun {
  let phase: "finished" | "preflight" | "stages" = "preflight";

  async function runStage<T>(stage: DeployStageId, run: () => Promise<T>): Promise<T> {
    events({ stage, type: "stage-started" });
    let result: T;
    try {
      result = await run();
    } catch (error) {
      events({ message: describeError(error, "single-line"), stage, type: "stage-failed" });
      throw error;
    }
    events({ stage, type: "stage-succeeded" });
    return result;
  }

  return {
    failOnce(error) {
      if (phase === "finished") return;
      if (phase === "preflight") {
        events({ message: describeError(error, "single-line"), type: "preflight-failed" });
      }
      events({ outcome: "failed", type: "finished" });
      phase = "finished";
    },
    runStage,
    start(started) {
      events({ ...started, type: "started" });
      phase = "stages";
    },
    succeed(installation) {
      const { createdAt: _createdAt, id: _id, ...recorded } = installation;
      events({ installation: decodeRecordedInstallation(recorded), type: "recorded" });
      events({ outcome: "succeeded", type: "finished" });
      phase = "finished";
    },
  };
}
