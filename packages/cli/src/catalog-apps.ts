import type { CommandCatalog } from "./types.ts";
import {
  action,
  id,
  json,
  lifecycleAction,
  mutate,
  positional,
  requiredText,
  show,
  text,
} from "./catalog-helpers.ts";

const APPS_PATH = "/v1/apps";
const pagination = { limitField: "limit", maxLimit: 100, target: "query" } as const;
const appId = positional("App ID");

export const appCommandCatalog: CommandCatalog = {
  app: {
    summary: "Internal apps that agents build and members sign in to",
    actions: {
      list: action({
        summary: "List apps, or find one by its slug",
        method: "GET",
        path: APPS_PATH,
        scope: "environment",
        output: "list",
        pagination,
        args: { slug: text("Only the app with this exact slug", "query") },
      }),
      show: show(APPS_PATH, "environment", "Show an app, its URL, and its lifecycle"),
      update: action({
        summary: "Rename an app, set member access, or hand it to another agent definition",
        method: "PATCH",
        path: `${APPS_PATH}/:id`,
        scope: "environment",
        output: "detail",
        idempotent: true,
        args: {
          id,
          name: text("App name"),
          access: json(
            'Access for every organization member, such as {"organizationMembers":"viewer"}',
          ),
          "agent-definition-id": text("Agent definition whose runs can reach the app"),
        },
      }),
      "set-publication": action({
        summary: "Change an app's audience and serving settings (needs apps:publish)",
        method: "PATCH",
        path: `${APPS_PATH}/:id/publication`,
        scope: "environment",
        output: "detail",
        idempotent: true,
        args: {
          id,
          audience: text("members or public"),
          serving: text("single-page or static-site"),
        },
      }),
      archive: lifecycleAction(
        APPS_PATH,
        "archive",
        "environment",
        "Archive an app so it stops serving members and agents",
        { id },
        true,
      ),
      erase: mutate("DELETE", APPS_PATH, "environment", "Erase an app and its data", { id }),
    },
  },
  "app-grant": {
    summary: "Member roles on an app beyond its organization-wide access",
    actions: {
      list: action({
        summary: "List an app's member grants",
        method: "GET",
        path: `${APPS_PATH}/:appId/grants`,
        scope: "environment",
        output: "list",
        pagination,
        args: { appId },
      }),
      set: action({
        summary: "Grant an organization member viewer or editor on an app",
        method: "PUT",
        path: `${APPS_PATH}/:appId/grants/:principalId`,
        scope: "environment",
        output: "detail",
        idempotent: true,
        args: {
          appId,
          principalId: positional("Member principal ID"),
          role: requiredText("viewer or editor"),
        },
      }),
      remove: action({
        summary: "Remove a member's grant on an app",
        method: "DELETE",
        path: `${APPS_PATH}/:appId/grants/:principalId`,
        scope: "environment",
        output: "action",
        idempotent: true,
        destructive: true,
        args: { appId, principalId: positional("Member principal ID") },
      }),
    },
  },
  "app-release": {
    summary: "Published builds of an app's UI",
    actions: {
      list: action({
        summary: "List an app's releases, newest first",
        method: "GET",
        path: `${APPS_PATH}/:appId/releases`,
        scope: "environment",
        output: "list",
        pagination,
        args: { appId },
      }),
      promote: action({
        summary: "Serve a release to members; promote an earlier release to roll back",
        method: "POST",
        path: `${APPS_PATH}/:appId/releases/:releaseId/promote`,
        scope: "environment",
        output: "detail",
        idempotent: true,
        args: { appId, releaseId: positional("Release ID") },
      }),
    },
  },
  "app-domain": {
    summary: "Custom hostnames that serve an app once their DNS records are published",
    actions: {
      list: action({
        summary: "List an app's custom domains and the DNS records each one needs",
        method: "GET",
        path: `${APPS_PATH}/:appId/domains`,
        scope: "environment",
        output: "list",
        pagination,
        args: { appId },
      }),
      attach: action({
        summary:
          "Attach a hostname to an app and print the DNS records to publish (needs apps:publish)",
        method: "POST",
        path: `${APPS_PATH}/:appId/domains`,
        scope: "environment",
        output: "detail",
        idempotent: true,
        args: { appId, hostname: requiredText("Hostname, such as www.example.com") },
      }),
      refresh: action({
        summary: "Check a domain's DNS TXT record, queue its edge setup, and report its state",
        method: "POST",
        path: `${APPS_PATH}/:appId/domains/:domainId/refresh`,
        scope: "environment",
        output: "detail",
        args: { appId, domainId: positional("Domain ID") },
      }),
      detach: action({
        summary: "Detach a custom domain from an app",
        method: "DELETE",
        path: `${APPS_PATH}/:appId/domains/:domainId`,
        scope: "environment",
        output: "detail",
        idempotent: true,
        destructive: true,
        args: { appId, domainId: positional("Domain ID") },
      }),
    },
  },
};
