import { PUBLIC_API_ROUTES } from "@deployments-ai/api-contract/product";
import type { CommandCatalog } from "./types.ts";
import { agentEmailCommandCatalog } from "./catalog-agent-email.ts";
import { appCommandCatalog } from "./catalog-apps.ts";
import { emailCommandCatalog } from "./catalog-email.ts";
import { agentCommandCatalog } from "./catalog-agents.ts";
import { brainCommandCatalog } from "./catalog-brains.ts";
import { hostedCodeCommandCatalog } from "./catalog-hosted-code.ts";
import { evaluationCommandCatalog } from "./catalog-evaluations.ts";
import { budgetCommandCatalog } from "./catalog-budgets.ts";
import { monitorCommandCatalog } from "./catalog-monitors.ts";
import { credentialReferenceCommandCatalog } from "./catalog-credential-references.ts";
import { directoryCommandCatalog } from "./catalog-directory.ts";
import { erasureCommandCatalog } from "./catalog-erasures.ts";
import { governanceCommandCatalog } from "./catalog-governance.ts";
import { modelCommandCatalog } from "./catalog-models.ts";
import { identityFederationCommandCatalog } from "./catalog-identity-federation.ts";
import { operationsCommandCatalog } from "./catalog-operations.ts";
import { observabilityCommandCatalog } from "./catalog-observability.ts";
import { controlResourceCommandCatalog } from "./catalog-control-resources.ts";
import { organizationCommandCatalog } from "./catalog-organization.ts";
import { runtimeCommandCatalog } from "./catalog-runtime.ts";
import { toolCommandCatalog } from "./catalog-tools.ts";
import { systemCommandCatalog } from "./catalog-system.ts";

export const scaffoldCommandCatalog: CommandCatalog = {
  ...organizationCommandCatalog,
  ...credentialReferenceCommandCatalog,
  ...identityFederationCommandCatalog,
  ...directoryCommandCatalog,
  ...budgetCommandCatalog,
  ...monitorCommandCatalog,
  ...agentCommandCatalog,
  ...appCommandCatalog,
  ...toolCommandCatalog,
  ...brainCommandCatalog,
  ...modelCommandCatalog,
  ...hostedCodeCommandCatalog,
  ...runtimeCommandCatalog,
  ...operationsCommandCatalog,
  ...observabilityCommandCatalog,
  ...evaluationCommandCatalog,
  ...controlResourceCommandCatalog,
  ...governanceCommandCatalog,
  ...erasureCommandCatalog,
  ...agentEmailCommandCatalog,
  ...emailCommandCatalog,
  ...systemCommandCatalog,
};

/** Summaries for top-level commands that group namespaced resources. */
export const commandNamespaces: Readonly<Record<string, string>> = {
  eval: "Evaluate agents with scores, regression datasets, runs, and release comparisons",
};

function normalizedRoute(method: string, path: string): string {
  return `${method} ${path.replaceAll(/:[^/]+/gu, "{}")}`;
}

const publicRoutes = new Set(
  PUBLIC_API_ROUTES.map((route) => normalizedRoute(route.method, route.path)),
);

export const commandCatalog: CommandCatalog = Object.fromEntries(
  Object.entries(scaffoldCommandCatalog).flatMap(([resourceName, resource]) => {
    const actions = Object.fromEntries(
      Object.entries(resource.actions).filter(([, actionSpec]) =>
        publicRoutes.has(normalizedRoute(actionSpec.method, actionSpec.path)),
      ),
    );
    return Object.keys(actions).length === 0
      ? []
      : [[resourceName, { ...resource, actions }] as const];
  }),
);

export const initialPlanCommands = [
  "auth login",
  "auth logout",
  "whoami",
  "org list",
  "project create",
  "project list",
  "project show",
  "env create",
  "env list",
  "env show",
  "service-account create",
  "service-account list",
  "service-account revoke",
  "api-key create",
  "api-key list",
  "api-key rotate",
  "api-key revoke",
  "provider list",
  "oauth-app register",
  "oauth-app list",
  "oauth-app rotate",
  "oauth-app archive",
  "connection authorize",
  "connection list",
  "connection verify",
  "connection revoke",
  "agent create",
  "agent list",
  "agent show",
  "agent release",
  "agent deploy",
  "run create",
  "run show",
  "run tail",
  "chat",
  "inbox list",
  "inbox create",
  "inbox messages",
  "usage show",
  "spend show",
  "webhook create",
  "webhook list",
] as const;
