import type { CommandCatalog } from "./types.ts";
import {
  action,
  id,
  json,
  list,
  mutate,
  number,
  positional,
  requiredJson,
  requiredText,
  show,
  text,
} from "./catalog-helpers.ts";

const MONITORS_PATH = "/v1/monitors";
const environmentFilter = text("Only this environment", "query");
const condition = json(
  'Condition as JSON, e.g. {"kind":"run-failures","threshold":3,"windowMinutes":15}',
);
const notify = json(
  'Who to notify as JSON, e.g. {"emailRoles":["owner"],"emailPrincipalIds":[],"webhooks":true}',
);

export const monitorCommandCatalog: CommandCatalog = {
  monitor: {
    summary: "Monitors that email members and send webhook events when something needs attention",
    actions: {
      list: list(MONITORS_PATH, "organization", "List monitors", {
        limitField: "limit",
        maxLimit: 100,
        target: "query",
      }),
      create: action({
        summary: "Create a monitor",
        method: "POST",
        path: MONITORS_PATH,
        scope: "organization",
        output: "detail",
        args: {
          name: requiredText("Monitor name"),
          condition: { ...requiredJson("Condition as JSON"), field: "condition" },
          notify: { ...requiredJson("Who to notify as JSON"), field: "notify" },
          "project-id": { ...text("Project of an environment monitor"), field: "projectId" },
          "environment-id": { ...text("Environment the monitor watches"), field: "environmentId" },
          "renotify-minutes": {
            ...number("Repeat the notification this often while firing"),
            field: "renotifyMinutes",
          },
        },
        idempotent: true,
      }),
      show: show(MONITORS_PATH, "organization", "Show a monitor"),
      update: action({
        summary: "Change, mute, or unmute a monitor",
        method: "PATCH",
        path: `${MONITORS_PATH}/:id`,
        scope: "organization",
        output: "detail",
        args: {
          id,
          name: text("Monitor name"),
          condition,
          notify,
          mute: json('Mute as JSON: {} until unmuted, {"until":"<time>"}, or null to unmute'),
          "renotify-minutes": {
            ...number("Repeat the notification this often while firing"),
            field: "renotifyMinutes",
          },
        },
        idempotent: true,
      }),
      archive: mutate("DELETE", MONITORS_PATH, "organization", "Archive a monitor", { id }),
      test: action({
        summary: "Send a test alert to yourself and the monitor's webhooks",
        method: "POST",
        path: `${MONITORS_PATH}/:id/test`,
        scope: "organization",
        output: "action",
        args: { id },
        idempotent: true,
      }),
      incidents: action({
        summary: "List alert incidents, newest first",
        method: "GET",
        path: "/v1/alert-incidents",
        scope: "organization",
        output: "list",
        args: { "environment-id": { ...environmentFilter, field: "environmentId" } },
        pagination: { limitField: "limit", maxLimit: 50, target: "query" },
      }),
      incident: action({
        summary: "Show one alert incident with its timeline",
        method: "GET",
        path: `${MONITORS_PATH}/:id/incidents/:incidentId`,
        scope: "organization",
        output: "detail",
        args: { id, "incident-id": { ...positional("Incident ID"), field: "incidentId" } },
      }),
      "notification-settings": action({
        summary: "Show your alert email settings",
        method: "GET",
        path: "/v1/alert-notification-preferences",
        scope: "organization",
        output: "detail",
      }),
      "set-notification-settings": action({
        summary: "Turn your alert emails on or off, or mute monitors",
        method: "PUT",
        path: "/v1/alert-notification-preferences",
        scope: "organization",
        output: "detail",
        args: {
          email: requiredText("all or none"),
          "muted-monitor-ids": {
            ...requiredJson("Monitor IDs to mute as a JSON array"),
            field: "mutedMonitorIds",
          },
        },
      }),
    },
  },
};
