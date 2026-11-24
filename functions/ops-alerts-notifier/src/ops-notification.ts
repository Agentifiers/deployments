import { Option, Schema } from "effect";

export const AlarmState = Schema.Literals(["ALARM", "OK", "INSUFFICIENT_DATA"]);
export type AlarmState = typeof AlarmState.Type;

export interface AlarmTransition {
  readonly alarmName: string;
  readonly description?: string;
  readonly state: AlarmState;
  readonly previousState: AlarmState;
  readonly reason: string;
  readonly changedAt: string;
  readonly region: string;
  readonly accountId: string;
  readonly metric?: { readonly namespace: string; readonly name: string };
}

export type OpsNotification =
  | { readonly kind: "alarm-transition"; readonly transition: AlarmTransition }
  | { readonly kind: "unrecognized"; readonly subject?: string; readonly message: string };

const SnsLambdaEvent = Schema.Struct({
  Records: Schema.Array(
    Schema.Struct({
      EventSource: Schema.Literal("aws:sns"),
      Sns: Schema.Struct({
        Message: Schema.String,
        Subject: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    }),
  ),
});

const CloudWatchAlarmMessage = Schema.Struct({
  AlarmArn: Schema.String,
  AlarmDescription: Schema.NullOr(Schema.String),
  AlarmName: Schema.String,
  AWSAccountId: Schema.String,
  NewStateReason: Schema.String,
  NewStateValue: AlarmState,
  OldStateValue: AlarmState,
  StateChangeTime: Schema.String,
  Trigger: Schema.optionalKey(
    Schema.Struct({
      MetricName: Schema.optionalKey(Schema.String),
      Namespace: Schema.optionalKey(Schema.String),
    }),
  ),
});
type CloudWatchAlarmMessage = typeof CloudWatchAlarmMessage.Type;

const decodeSnsLambdaEvent = Schema.decodeUnknownSync(SnsLambdaEvent);
const decodeCloudWatchAlarmMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(CloudWatchAlarmMessage),
);

const alarmArnRegion = /^arn:aws[a-z-]*:cloudwatch:([a-z0-9-]+):\d{12}:alarm:/u;

function alarmTransition(alarm: CloudWatchAlarmMessage): AlarmTransition | undefined {
  const region = alarmArnRegion.exec(alarm.AlarmArn)?.[1];
  const changedAt = new Date(alarm.StateChangeTime);
  if (region === undefined || Number.isNaN(changedAt.getTime())) return undefined;
  const { MetricName: name, Namespace: namespace } = alarm.Trigger ?? {};
  return {
    accountId: alarm.AWSAccountId,
    alarmName: alarm.AlarmName,
    changedAt: changedAt.toISOString(),
    previousState: alarm.OldStateValue,
    reason: alarm.NewStateReason,
    region,
    state: alarm.NewStateValue,
    ...(alarm.AlarmDescription ? { description: alarm.AlarmDescription } : {}),
    ...(name !== undefined && namespace !== undefined ? { metric: { name, namespace } } : {}),
  };
}

export function parseOpsNotifications(event: unknown): readonly OpsNotification[] {
  return decodeSnsLambdaEvent(event).Records.map(({ Sns }): OpsNotification => {
    const alarm = Option.getOrUndefined(decodeCloudWatchAlarmMessage(Sns.Message));
    const transition = alarm && alarmTransition(alarm);
    if (transition) return { kind: "alarm-transition", transition };
    return {
      kind: "unrecognized",
      message: Sns.Message,
      ...(Sns.Subject ? { subject: Sns.Subject } : {}),
    };
  });
}
