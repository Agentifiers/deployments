import type { SlackMessage } from "./slack-message.ts";

export const recordedAlarmMessage = String.raw`{"AlarmName":"agent-email-api-errors","AlarmDescription":"Agent email api Lambda reported an error.","AWSAccountId":"123456789012","AlarmConfigurationUpdatedTimestamp":"2026-08-01T15:06:41.137+0000","NewStateValue":"ALARM","NewStateReason":"Threshold Crossed: 1 out of the last 1 datapoints [2.0 (07/10/26 01:04:00)] was greater than the threshold (0.0) (minimum 1 datapoint for OK -> ALARM transition).","StateChangeTime":"2026-10-07T01:05:12.345+0000","Region":"US East (Ohio)","AlarmArn":"arn:aws:cloudwatch:us-east-2:123456789012:alarm:agent-email-api-errors","OldStateValue":"OK","OKActions":[],"AlarmActions":["arn:aws:sns:us-east-2:123456789012:ops-alerts"],"InsufficientDataActions":[],"Trigger":{"MetricName":"Errors","Namespace":"AWS/Lambda","StatisticType":"Statistic","Statistic":"SUM","Unit":null,"Dimensions":[{"value":"agent-email-api","name":"FunctionName"}],"Period":60,"EvaluationPeriods":1,"DatapointsToAlarm":1,"ComparisonOperator":"GreaterThanThreshold","Threshold":0.0,"TreatMissingData":"notBreaching","EvaluateLowSampleCountPercentile":""}}`;

export function snsEvent(input: { readonly subject: string | null; readonly message: string }) {
  return {
    Records: [
      {
        EventSource: "aws:sns",
        EventSubscriptionArn:
          "arn:aws:sns:us-east-2:123456789012:ops-alerts:2f4c3a1e-8d1b-4c55-9e0e-6b7f0f6f1a2b",
        EventVersion: "1.0",
        Sns: {
          Message: input.message,
          MessageAttributes: {},
          MessageId: "5a1f1c3e-2d7b-5e8a-9c4f-0b6d2e8f7a91",
          Signature:
            "EXAMPLEpH+DcEwjAPg8O9mY8dReBSwksfg2S7WKQcikcNKWLQjwu6A4VbeS0QHVCkhRS7fUQvi2egU3N858fiTDN6bkkOxYDVrY0Ad8L10Hs3zH81mtnPk5uvvolIC1CXGu43obcgFxeL3khZl8IKvO61GWB6jI9b5+gLPoBc1Q=",
          SignatureVersion: "1",
          SigningCertUrl:
            "https://sns.us-east-2.amazonaws.com/SimpleNotificationService-9c6465fa7f48f5cacd23014631ec1136.pem",
          Subject: input.subject,
          Timestamp: "2026-10-07T01:05:12.412Z",
          TopicArn: "arn:aws:sns:us-east-2:123456789012:ops-alerts",
          Type: "Notification",
          UnsubscribeUrl:
            "https://sns.us-east-2.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=arn:aws:sns:us-east-2:123456789012:ops-alerts:2f4c3a1e-8d1b-4c55-9e0e-6b7f0f6f1a2b",
        },
      },
    ],
  };
}

export const recordedAlarmEvent = snsEvent({
  message: recordedAlarmMessage,
  subject: 'ALARM: "agent-email-api-errors" in US East (Ohio)',
});

export const expectedAlarmSlackMessage = {
  attachments: [
    {
      blocks: [
        {
          text: {
            text: "*agent-email-api-errors*\nAgent email api Lambda reported an error.",
            type: "mrkdwn",
          },
          type: "section",
        },
        {
          fields: [
            { text: "*Environment*\ndev", type: "mrkdwn" },
            { text: "*State*\nALARM (was OK)", type: "mrkdwn" },
            { text: "*Changed*\n2026-10-07T01:05:12.345Z", type: "mrkdwn" },
            { text: "*Metric*\nAWS/Lambda Errors", type: "mrkdwn" },
          ],
          type: "section",
        },
        {
          text: {
            text: "*Reason*\nThreshold Crossed: 1 out of the last 1 datapoints [2.0 (07/10/26 01:04:00)] was greater than the threshold (0.0) (minimum 1 datapoint for OK -&gt; ALARM transition).",
            type: "mrkdwn",
          },
          type: "section",
        },
        {
          elements: [
            {
              text: "<https://us-east-2.console.aws.amazon.com/cloudwatch/home?region=us-east-2#alarmsV2:alarm/agent-email-api-errors|Open in CloudWatch> · Account 123456789012 · us-east-2",
              type: "mrkdwn",
            },
          ],
          type: "context",
        },
      ],
      color: "#E01E5A",
    },
  ],
  channel: "C0OPSALERTS",
  text: ":rotating_light: [dev] Alarm: agent-email-api-errors",
  unfurl_links: false,
} satisfies SlackMessage;
