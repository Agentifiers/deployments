import type { Thread } from "../server/runtime-data.ts";

type Actor = Thread["createdBy"];

const ACTOR_LABELS: Readonly<Record<Actor["type"], string>> = {
  agent: "Agent",
  principal: "Member",
  "service-account": "Service account",
  system: "Platform",
  worker: "Platform worker",
};

/** Who started a thread, in words; the signed-in member's own threads read "You". */
export function actorLabel(actor: Actor, principalId: string): string {
  return actor.type === "principal" && actor.id === principalId ? "You" : ACTOR_LABELS[actor.type];
}

const CHANNEL_LABELS: ReadonlyMap<string, string> = new Map([
  ["api", "API"],
  ["console", "Console"],
  ["email", "Email"],
  ["evaluation", "Evaluation"],
  ["imessage", "iMessage"],
  ["preview", "Preview"],
  ["rcs", "RCS"],
  ["slack", "Slack"],
  ["sms", "SMS"],
  ["teams", "Teams"],
  ["telegram", "Telegram"],
  ["workflow", "Workflow"],
]);

/** Where a thread came in, in words. A channel the console does not know shows as stored. */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS.get(channel) ?? channel;
}
