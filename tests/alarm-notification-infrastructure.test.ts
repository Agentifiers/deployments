import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type TerraformBlock = { readonly location: string; readonly name: string; readonly body: string };

const modulesRoot = "infrastructure/modules";
const platformRoot = join(modulesRoot, "platform");
const environmentRoots = ["infrastructure/environments/customer"];

const blockBody = (source: string, openBrace: number) => {
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openBrace + 1, index);
  }
  throw new Error(`unbalanced block at offset ${openBrace}`);
};

const terraformBlocks = (directory: string, header: RegExp): TerraformBlock[] =>
  readdirSync(directory)
    .filter((fileName) => fileName.endsWith(".tf"))
    .sort()
    .flatMap((fileName) => {
      const source = readFileSync(join(directory, fileName), "utf8");
      return [...source.matchAll(header)].map((match) => ({
        location: join(directory, fileName).slice("infrastructure/".length),
        name: match[1] ?? "",
        body: blockBody(source, (match.index ?? 0) + match[0].length - 1),
      }));
    });

const attribute = (body: string, name: string) =>
  body.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "mu"))?.[1]?.trim();

const platformModuleCalls = terraformBlocks(platformRoot, /^module "([^"]+)" \{/gmu).flatMap(
  (call) => {
    const childDirectory = attribute(call.body, "source")?.match(/^"\.\.\/([^"]+)"$/u)?.[1];
    return childDirectory === undefined ? [] : [{ ...call, childDirectory }];
  },
);
const childDirectories = [...new Set(platformModuleCalls.map((call) => call.childDirectory))];

const alarms = childDirectories.flatMap((childDirectory) =>
  terraformBlocks(
    join(modulesRoot, childDirectory),
    /^resource "aws_cloudwatch_metric_alarm" "([^"]+)" \{/gmu,
  ).map((alarm) => ({
    childDirectory,
    id: `${alarm.location}:${alarm.name}`,
    alarmActions: attribute(alarm.body, "alarm_actions"),
    okActions: attribute(alarm.body, "ok_actions"),
  })),
);

const childrenWithAlarmTopicInput = new Set(
  childDirectories.filter((childDirectory) =>
    terraformBlocks(join(modulesRoot, childDirectory), /^variable "([^"]+)" \{/gmu).some(
      (variable) => variable.name === "alarm_topic_arn",
    ),
  ),
);

const notifiesTopic = (childDirectory: string, actions: string | undefined) =>
  childDirectory === "ops-alerts"
    ? /^\[aws_sns_topic\.\w+\.arn\]$/u.test(actions ?? "")
    : /\bvar\.alarm_topic_arn\b/u.test(actions ?? "");

describe("platform alarm notification", () => {
  test("composes the ops alerts module into the platform", () => {
    expect(
      platformModuleCalls
        .filter((call) => call.name === "ops_alerts")
        .map((call) => call.childDirectory),
    ).toEqual(["ops-alerts"]);
  });

  test("every platform-composed alarm notifies the ops alerts topic on alarm and recovery", () => {
    expect(alarms.find((alarm) => alarm.id === "modules/agent-runtime/alarms.tf:dlq")).toEqual({
      childDirectory: "agent-runtime",
      id: "modules/agent-runtime/alarms.tf:dlq",
      alarmActions: "[var.alarm_topic_arn]",
      okActions: "[var.alarm_topic_arn]",
    });
    expect(
      alarms
        .filter(
          (alarm) =>
            !notifiesTopic(alarm.childDirectory, alarm.alarmActions) ||
            !notifiesTopic(alarm.childDirectory, alarm.okActions),
        )
        .map((alarm) => alarm.id),
    ).toEqual([]);
  });

  test("every child module with alarms receives the ops alerts topic from the platform", () => {
    expect(
      [...new Set(alarms.map((alarm) => alarm.childDirectory))].filter(
        (childDirectory) =>
          childDirectory !== "ops-alerts" && !childrenWithAlarmTopicInput.has(childDirectory),
      ),
    ).toEqual([]);
    expect(
      platformModuleCalls
        .filter(
          (call) =>
            childrenWithAlarmTopicInput.has(call.childDirectory) &&
            attribute(call.body, "alarm_topic_arn") !== "module.ops_alerts.topic_arn",
        )
        .map((call) => `${call.location}:${call.name}`),
    ).toEqual([]);
    expect(
      platformModuleCalls
        .filter((call) => call.name === "agent_runtime")
        .map((call) => attribute(call.body, "alarm_topic_arn")),
    ).toEqual(["module.ops_alerts.topic_arn"]);
  });

  test("leaves no per-component alarm action inputs in the platform or environment roots", () => {
    expect(
      [platformRoot, ...environmentRoots]
        .flatMap((directory) => terraformBlocks(directory, /^variable "([^"]+)" \{/gmu))
        .filter((variable) => variable.name.endsWith("alarm_actions"))
        .map((variable) => `${variable.location}:${variable.name}`),
    ).toEqual([]);
  });
});
