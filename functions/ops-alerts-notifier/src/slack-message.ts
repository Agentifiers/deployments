import type { AlarmState, OpsNotification } from "./ops-notification.ts";

interface MrkdwnText {
  readonly type: "mrkdwn";
  readonly text: string;
}

type SlackBlock =
  | { readonly type: "section"; readonly text: MrkdwnText }
  | { readonly type: "section"; readonly fields: readonly MrkdwnText[] }
  | { readonly type: "context"; readonly elements: readonly MrkdwnText[] };

export interface SlackMessage {
  readonly channel: string;
  readonly text: string;
  readonly unfurl_links: false;
  readonly attachments: readonly [
    { readonly color: string; readonly blocks: readonly SlackBlock[] },
  ];
}

interface Presentation {
  readonly emoji: string;
  readonly color: string;
  readonly label: string;
}

const alarmStatePresentation = {
  ALARM: { color: "#E01E5A", emoji: ":rotating_light:", label: "Alarm" },
  INSUFFICIENT_DATA: { color: "#ECB22E", emoji: ":grey_question:", label: "Insufficient data" },
  OK: { color: "#2EB67D", emoji: ":white_check_mark:", label: "OK" },
} as const satisfies Record<AlarmState, Presentation>;

const unrecognizedPresentation = {
  color: "#9E9E9E",
  emoji: ":information_source:",
  label: "Unrecognized notification",
} as const satisfies Presentation;

const SECTION_TEXT_LIMIT = 3000;
const TRUNCATION_MARK = "…";

function escapeMrkdwn(raw: string) {
  return raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function mrkdwn(text: string): MrkdwnText {
  return { text, type: "mrkdwn" };
}

function field(heading: string, value: string) {
  return mrkdwn(`*${heading}*\n${escapeMrkdwn(value)}`);
}

function truncateEscapedMrkdwn(raw: string, budget: number) {
  let kept = "";
  for (const character of raw) {
    const next = escapeMrkdwn(character);
    if (kept.length + next.length > budget) break;
    kept += next;
  }
  return kept;
}

function section(heading: string, raw: string): SlackBlock {
  const escaped = escapeMrkdwn(raw);
  const budget = SECTION_TEXT_LIMIT - heading.length;
  if (escaped.length <= budget) return { text: mrkdwn(heading + escaped), type: "section" };
  const kept = truncateEscapedMrkdwn(raw, budget - TRUNCATION_MARK.length);
  return { text: mrkdwn(`${heading}${kept}${TRUNCATION_MARK}`), type: "section" };
}

export function renderSlackMessage(input: {
  readonly notification: OpsNotification;
  readonly environment: string;
  readonly channelId: string;
}): SlackMessage {
  const { channelId, environment, notification } = input;
  switch (notification.kind) {
    case "alarm-transition": {
      const { transition } = notification;
      const { color, emoji, label } = alarmStatePresentation[transition.state];
      const name = `*${escapeMrkdwn(transition.alarmName)}*`;
      const consoleUrl = `https://${transition.region}.console.aws.amazon.com/cloudwatch/home?region=${transition.region}#alarmsV2:alarm/${encodeURIComponent(transition.alarmName)}`;
      return {
        attachments: [
          {
            blocks: [
              transition.description === undefined
                ? { text: mrkdwn(name), type: "section" }
                : section(`${name}\n`, transition.description),
              {
                fields: [
                  field("Environment", environment),
                  field("State", `${transition.state} (was ${transition.previousState})`),
                  field("Changed", transition.changedAt),
                  ...(transition.metric
                    ? [field("Metric", `${transition.metric.namespace} ${transition.metric.name}`)]
                    : []),
                ],
                type: "section",
              },
              section("*Reason*\n", transition.reason),
              {
                elements: [
                  mrkdwn(
                    `<${consoleUrl}|Open in CloudWatch> · Account ${transition.accountId} · ${transition.region}`,
                  ),
                ],
                type: "context",
              },
            ],
            color,
          },
        ],
        channel: channelId,
        text: escapeMrkdwn(`${emoji} [${environment}] ${label}: ${transition.alarmName}`),
        unfurl_links: false,
      };
    }
    case "unrecognized": {
      const { color, emoji, label } = unrecognizedPresentation;
      const subject = notification.subject ?? "(no subject)";
      return {
        attachments: [
          {
            blocks: [
              {
                fields: [field("Environment", environment), field("Subject", subject)],
                type: "section",
              },
              section("*Message*\n", notification.message),
            ],
            color,
          },
        ],
        channel: channelId,
        text: escapeMrkdwn(`${emoji} [${environment}] ${label}: ${subject}`),
        unfurl_links: false,
      };
    }
    default: {
      const exhaustive: never = notification;
      return exhaustive;
    }
  }
}
