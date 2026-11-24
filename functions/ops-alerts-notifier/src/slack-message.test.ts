import { describe, expect, test } from "bun:test";
import {
  expectedAlarmSlackMessage,
  recordedAlarmEvent,
  snsEvent,
} from "./cloudwatch-alarm-event.fixture.ts";
import { parseOpsNotifications } from "./ops-notification.ts";
import { renderSlackMessage } from "./slack-message.ts";

function render(event: unknown, environment: string) {
  return parseOpsNotifications(event).map((notification) =>
    renderSlackMessage({ channelId: "C0OPSALERTS", environment, notification }),
  );
}

describe("ops alert Slack messages", () => {
  test("renders a recorded CloudWatch ALARM transition delivered through SNS", () => {
    expect(render(recordedAlarmEvent, "dev")).toEqual([expectedAlarmSlackMessage]);
  });

  test("renders an OK transition of a metric math alarm without a description", () => {
    const event = snsEvent({
      message: String.raw`{"AlarmName":"agent-worker/run-slot utilization","AlarmDescription":null,"AWSAccountId":"123456789012","NewStateValue":"OK","NewStateReason":"Threshold Crossed: 1 datapoint [0.0 (02/10/26 04:54:00)] was not greater than the threshold (60.0).","StateChangeTime":"2026-10-02T04:55:12.763+0000","Region":"US East (Ohio)","AlarmArn":"arn:aws:cloudwatch:us-east-2:123456789012:alarm:agent-worker/run-slot utilization","OldStateValue":"ALARM","OKActions":["arn:aws:sns:us-east-2:123456789012:ops-alerts"],"AlarmActions":["arn:aws:sns:us-east-2:123456789012:ops-alerts"],"InsufficientDataActions":[],"Trigger":{"Period":60,"EvaluationPeriods":3,"ComparisonOperator":"GreaterThanThreshold","Threshold":60.0,"TreatMissingData":"missing","EvaluateLowSampleCountPercentile":"","Metrics":[{"Id":"utilization","Expression":"100 * busy / slots","Label":"RunSlotUtilization","ReturnData":true}]}}`,
      subject: 'OK: "agent-worker/run-slot utilization" in US East (Ohio)',
    });

    expect(render(event, "dev")).toEqual([
      {
        attachments: [
          {
            blocks: [
              {
                text: { text: "*agent-worker/run-slot utilization*", type: "mrkdwn" },
                type: "section",
              },
              {
                fields: [
                  { text: "*Environment*\ndev", type: "mrkdwn" },
                  { text: "*State*\nOK (was ALARM)", type: "mrkdwn" },
                  { text: "*Changed*\n2026-10-02T04:55:12.763Z", type: "mrkdwn" },
                ],
                type: "section",
              },
              {
                text: {
                  text: "*Reason*\nThreshold Crossed: 1 datapoint [0.0 (02/10/26 04:54:00)] was not greater than the threshold (60.0).",
                  type: "mrkdwn",
                },
                type: "section",
              },
              {
                elements: [
                  {
                    text: "<https://us-east-2.console.aws.amazon.com/cloudwatch/home?region=us-east-2#alarmsV2:alarm/agent-worker%2Frun-slot%20utilization|Open in CloudWatch> · Account 123456789012 · us-east-2",
                    type: "mrkdwn",
                  },
                ],
                type: "context",
              },
            ],
            color: "#2EB67D",
          },
        ],
        channel: "C0OPSALERTS",
        text: ":white_check_mark: [dev] OK: agent-worker/run-slot utilization",
        unfurl_links: false,
      },
    ]);
  });

  test("renders an INSUFFICIENT_DATA transition", () => {
    const event = snsEvent({
      message: String.raw`{"AlarmName":"agent-email-events-dlq-visible","AlarmDescription":"Agent email events dead-letter queue contains messages.","AWSAccountId":"123456789012","AlarmConfigurationUpdatedTimestamp":"2026-08-01T15:06:41.137+0000","NewStateValue":"INSUFFICIENT_DATA","NewStateReason":"Insufficient Data: 1 datapoint was unknown.","StateChangeTime":"2026-10-01T06:43:02.316+0000","Region":"US East (Ohio)","AlarmArn":"arn:aws:cloudwatch:us-east-2:123456789012:alarm:agent-email-events-dlq-visible","OldStateValue":"OK","OKActions":[],"AlarmActions":["arn:aws:sns:us-east-2:123456789012:ops-alerts"],"InsufficientDataActions":["arn:aws:sns:us-east-2:123456789012:ops-alerts"],"Trigger":{"MetricName":"ApproximateNumberOfMessagesVisible","Namespace":"AWS/SQS","StatisticType":"Statistic","Statistic":"MAXIMUM","Unit":null,"Dimensions":[{"value":"agent-email-events-dlq","name":"QueueName"}],"Period":60,"EvaluationPeriods":1,"ComparisonOperator":"GreaterThanThreshold","Threshold":0.0,"TreatMissingData":"notBreaching","EvaluateLowSampleCountPercentile":""}}`,
      subject: 'INSUFFICIENT_DATA: "agent-email-events-dlq-visible" in US East (Ohio)',
    });

    expect(render(event, "prod")).toEqual([
      {
        attachments: [
          {
            blocks: [
              {
                text: {
                  text: "*agent-email-events-dlq-visible*\nAgent email events dead-letter queue contains messages.",
                  type: "mrkdwn",
                },
                type: "section",
              },
              {
                fields: [
                  { text: "*Environment*\nprod", type: "mrkdwn" },
                  { text: "*State*\nINSUFFICIENT_DATA (was OK)", type: "mrkdwn" },
                  { text: "*Changed*\n2026-10-01T06:43:02.316Z", type: "mrkdwn" },
                  { text: "*Metric*\nAWS/SQS ApproximateNumberOfMessagesVisible", type: "mrkdwn" },
                ],
                type: "section",
              },
              {
                text: {
                  text: "*Reason*\nInsufficient Data: 1 datapoint was unknown.",
                  type: "mrkdwn",
                },
                type: "section",
              },
              {
                elements: [
                  {
                    text: "<https://us-east-2.console.aws.amazon.com/cloudwatch/home?region=us-east-2#alarmsV2:alarm/agent-email-events-dlq-visible|Open in CloudWatch> · Account 123456789012 · us-east-2",
                    type: "mrkdwn",
                  },
                ],
                type: "context",
              },
            ],
            color: "#ECB22E",
          },
        ],
        channel: "C0OPSALERTS",
        text: ":grey_question: [prod] Insufficient data: agent-email-events-dlq-visible",
        unfurl_links: false,
      },
    ]);
  });

  test("renders a message that is not JSON as an unrecognized notification", () => {
    const event = snsEvent({ message: "hello", subject: "Manual test" });

    expect(render(event, "dev")).toEqual([
      {
        attachments: [
          {
            blocks: [
              {
                fields: [
                  { text: "*Environment*\ndev", type: "mrkdwn" },
                  { text: "*Subject*\nManual test", type: "mrkdwn" },
                ],
                type: "section",
              },
              { text: { text: "*Message*\nhello", type: "mrkdwn" }, type: "section" },
            ],
            color: "#9E9E9E",
          },
        ],
        channel: "C0OPSALERTS",
        text: ":information_source: [dev] Unrecognized notification: Manual test",
        unfurl_links: false,
      },
    ]);
  });

  test("truncates an oversized unrecognized message on an escape boundary under 3000 characters", () => {
    const [message] = render(snsEvent({ message: "<".repeat(5000), subject: null }), "dev");

    expect(message?.text).toBe(
      ":information_source: [dev] Unrecognized notification: (no subject)",
    );
    expect(message?.attachments[0].blocks[1]).toEqual({
      text: { text: `*Message*\n${"&lt;".repeat(747)}…`, type: "mrkdwn" },
      type: "section",
    });
  });
});
