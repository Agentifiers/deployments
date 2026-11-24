import { AppAudience, AppServing, liveReleaseIdOf, type AppRecord } from "@deployments-ai/db";
import type { AppToolName } from "@deployments-ai/tools";
import { Option, Schema } from "effect";

export type AppWriteToolName = Exclude<
  AppToolName,
  "app.create" | "app.describe" | "app.list" | "app.query"
>;

export type ApprovalRule =
  | "never"
  | ((app: AppRecord, input: Readonly<Record<string, unknown>>) => string | null);

export const decodePublicationChange = Schema.decodeUnknownOption(
  Schema.Struct({
    audience: Schema.optionalKey(AppAudience),
    serving: Schema.optionalKey(AppServing),
  }),
);

function approvalReason(subject: string, predicates: readonly (string | false)[]) {
  const reasons = predicates.filter((predicate) => predicate !== false);
  return reasons.length === 0
    ? null
    : `This call needs approval because ${subject} ${reasons.join(" and ")}.`;
}

function whileLiveOrPublic(app: AppRecord) {
  return approvalReason(`app ${app.data.slug}`, [
    liveReleaseIdOf(app.data.lifecycle) !== null && "is live",
    app.data.publication.audience === "public" && "has a public audience",
  ]);
}

export const APPROVAL_RULES: Readonly<Record<AppWriteToolName, ApprovalRule>> = {
  "app.dev_token": "never",
  "app.migrate": whileLiveOrPublic,
  "app.promote": (app, input) => {
    const live = liveReleaseIdOf(app.data.lifecycle);
    if (input.releaseId === live) return null;
    return approvalReason(
      live === null
        ? `app ${app.data.slug}, which has no live release yet,`
        : `app ${app.data.slug}`,
      [
        live !== null && `is live on release ${live}`,
        app.data.publication.audience === "public" && "has a public audience",
      ],
    );
  },
  "app.release": "never",
  "app.set_publication": (app, input) => {
    const change = Option.getOrUndefined(decodePublicationChange(input));
    const current = app.data.publication;
    const live = liveReleaseIdOf(app.data.lifecycle) !== null;
    return approvalReason("it", [
      change?.audience === "public" &&
        current.audience !== "public" &&
        (live
          ? `opens live app ${app.data.slug} to anyone on the internet`
          : `opens app ${app.data.slug}, which has no live release yet, to anyone on the internet`),
      change?.serving !== undefined &&
        change.serving !== current.serving &&
        live &&
        `changes how live app ${app.data.slug} serves pages`,
    ]);
  },
};
