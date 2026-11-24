import type { IconSvgElement } from "@hugeicons/react";
import type { QueryClient } from "@tanstack/react-query";
import { rootRouteId, useRouteContext } from "@tanstack/react-router";
import type { ComponentType } from "react";
import type { ConsoleRoute, Gate } from "./navigation.ts";

/** A host page outside the console's route tree, so its link is a plain path. */
export interface EditionNavItem {
  readonly label: string;
  readonly icon: IconSvgElement;
  readonly href: (organizationId: string) => string;
  /** Hidden when the caller may not use these operations; ungated items show to every member. */
  readonly gate?: Gate;
}

/**
 * Who runs the install. `managed` is a hosted service whose operator bills its customers;
 * `self-hosted` is an install an organization runs for itself from the source-available platform.
 */
export type InstallKind = "managed" | "self-hosted";

/** Copy that names who pays for or runs the install, keyed by install kind. */
export interface InstallCopy {
  /** Label for spend the install pays for, as opposed to spend on the organization's own keys. */
  readonly operatorFundedLabel: string;
  /** Sentence fragment naming that payer, as in "Other model calls are paid by ___". */
  readonly operatorFundedPayer: string;
  /** What to do about a feature the organization's plan leaves out. */
  readonly featureNotInPlan: string;
  /** Why traces, metrics, and run totals cannot be read, and who can fix it. */
  readonly observabilityUnavailable: string;
  /** Said before erasing an organization; `undefined` when billing does not stand in the way. */
  readonly erasureBillingNote?: string;
  /** Why a model provider's keys cannot be stored for the organization. */
  readonly providerKeysNotAccepted: (provider: string) => string;
  /** What the included-spend alert watches. */
  readonly includedSpendExhausted: string;
  /** Why Brain search and ask cannot run at all. */
  readonly brainSearchUnavailable: string;
  /** Why this console cannot receive OAuth callbacks. */
  readonly oauthReturnUnavailable: string;
  /** Why a provider has no platform OAuth app. */
  readonly oauthProviderUnconfigured: string;
  /** A memory write failed, probably because memory search is off for the organization. */
  readonly memorySearchNeeded: (action: string) => string;
  /** Who turns on Memory and Brain search, and what to do meanwhile. */
  readonly searchNotEnabled: string;
  /** Why agent email is missing. */
  readonly agentEmailNotInstalled: string;
  /** The domain an inbox without a custom domain uses, as a noun phrase. */
  readonly hostedEmailDomain: string;
  /** The Kind of that domain on its detail page. */
  readonly hostedEmailDomainKind: string;
  /** Whether customers manage their own sending placements and transactional tenants. */
  readonly managesEmailSending: boolean;
  /** Why the Alerts page cannot list monitors yet. */
  readonly alertsNotDeployed: { readonly description: string; readonly title: string };
  /** Shown to a signed-in person who belongs to no organization. */
  readonly noOrganizations: string;
  /** Shown on `/system` to someone who may not use it. */
  readonly systemAccessDenied: string;
  /** Whether the `billing` organization role means anything here. */
  readonly offersBillingRole: boolean;
}

export const INSTALL_COPY: Readonly<Record<InstallKind, InstallCopy>> = {
  managed: {
    agentEmailNotInstalled:
      "Agent email is not available for your organization yet. Contact support to turn it on.",
    alertsNotDeployed: {
      description:
        "Alerts are not available for your organization yet, so there are no monitors or alert history to show. Your role and API key scopes are not the cause.",
      title: "Alerts are not available yet",
    },
    brainSearchUnavailable:
      "Brain search is not available for your organization yet, so search and ask cannot run. Contact support to turn it on.",
    erasureBillingNote:
      "If the organization has a paid subscription, cancel it on the Billing page first.",
    featureNotInPlan: "Upgrade your plan to use it.",
    hostedEmailDomain: "a domain Deployments.ai hosts for you",
    hostedEmailDomainKind: "Hosted by Deployments.ai",
    includedSpendExhausted: "The model spend included in your plan this month is used up.",
    managesEmailSending: false,
    memorySearchNeeded: (action) =>
      `${action} needs memory search, which may not be turned on for your organization yet. Retry, and if this keeps happening, contact support.`,
    noOrganizations: "You are not a member of any organization yet.",
    oauthProviderUnconfigured:
      "Deployments.ai does not support connecting this provider over OAuth yet. Contact support if you need it.",
    oauthReturnUnavailable:
      "Deployments.ai cannot finish OAuth sign-ins for this console address. Contact support.",
    observabilityUnavailable:
      "Traces, metrics, and run totals are temporarily unavailable. Your agents keep running, and their runs and threads are still recorded. If this lasts, contact support.",
    offersBillingRole: true,
    operatorFundedLabel: "Billed by your plan",
    operatorFundedPayer: "your plan",
    providerKeysNotAccepted: (provider) => `Deployments.ai does not accept ${provider} keys yet.`,
    searchNotEnabled:
      "Search may not be turned on for your organization yet. Retry, and if this keeps happening, contact support.",
    systemAccessDenied:
      "This page is for Deployments.ai staff. Your organization's pages are in the sidebar.",
  },
  "self-hosted": {
    agentEmailNotInstalled:
      "Agent email is an optional install component. An operator enables it in the platform deployment.",
    alertsNotDeployed: {
      description:
        "This installation does not serve the monitors API yet, so there are no monitors or alert history to show. Your role and API key scopes are not the cause.",
      title: "Alerts are not available on this installation yet",
    },
    brainSearchUnavailable:
      "This platform install has no Brain query runtime, so search and ask cannot run until an operator configures one.",
    featureNotInPlan: "Ask your installation's administrator to turn it on.",
    hostedEmailDomain: "the install's hosted domain",
    hostedEmailDomainKind: "Hosted by the install",
    includedSpendExhausted: "The model spend the installation pays for this month is used up.",
    managesEmailSending: true,
    memorySearchNeeded: (action) =>
      `${action} needs memory search, which an operator enables for the organization. If search is already enabled, retry; the error is the platform's.`,
    noOrganizations: "You are not a member of any organization in this install.",
    oauthProviderUnconfigured:
      "This deployment has no platform OAuth configuration for the provider. Operators add it to channel_provider_oauth_apps_json.",
    oauthReturnUnavailable:
      "The platform does not send OAuth callbacks back to this console's address yet. Operators add the console origin to PLATFORM_OAUTH_RETURN_ORIGINS, which the platform OpenTofu does when the console is enabled.",
    observabilityUnavailable:
      "This installation has no observability service, or the console cannot reach it, so traces, metrics, and run totals cannot be shown. Runs and threads are still recorded. Operators enable the service with agent_observability_hot_enabled.",
    offersBillingRole: false,
    operatorFundedLabel: "Paid by the installation",
    operatorFundedPayer: "the installation",
    providerKeysNotAccepted: (provider) => `This installation does not accept ${provider} keys.`,
    searchNotEnabled:
      "An operator enables search for the organization. If search is already enabled, retry; the error is the platform's.",
    systemAccessDenied:
      "Only platform administrators can operate the install. Ask an administrator of this install for access.",
  },
};

/**
 * The console's one extension seam. An app that mounts the console's route files under its own
 * root passes an edition to `createConsoleRouter`; nothing else in the console varies by host.
 */
export interface ConsoleEdition {
  readonly install: InstallKind;
  readonly productName: string;
  /** Console routes the host did not mount; links to them are not rendered. */
  readonly hiddenRoutes: readonly ConsoleRoute[];
  /** Host pages listed after the console's organization pages. */
  readonly organizationNavigation: readonly EditionNavItem[];
  /** Rendered on every organization page, below the standing banner. */
  readonly organizationNotice?: ComponentType<{ readonly organizationId: string }>;
  /** Host panels on an organization's `/system` page, after its standing, history, and spend. */
  readonly systemOrganizationPanels?: readonly ComponentType<{ readonly organizationId: string }>[];
}

export const DEFAULT_CONSOLE_EDITION: ConsoleEdition = {
  hiddenRoutes: [],
  install: "self-hosted",
  organizationNavigation: [],
  productName: "Deployments.ai Console",
};

export interface ConsoleRouterContext {
  readonly edition: ConsoleEdition;
  readonly queryClient: QueryClient;
}

/** Operator actions link into `/system`, so they show only where it is mounted. */
export function showsSystem(edition: ConsoleEdition): boolean {
  return !edition.hiddenRoutes.includes("/system");
}

export function useConsoleEdition(): ConsoleEdition {
  return useRouteContext({ from: rootRouteId, select: (context) => context.edition });
}

export function useInstallCopy(): InstallCopy {
  return INSTALL_COPY[useConsoleEdition().install];
}

/**
 * The install kind of the most recently created console router. An app serves one edition, so
 * code that runs outside React, such as problem copy built in mutation callbacks, reads it here.
 */
let routerInstall: InstallKind = DEFAULT_CONSOLE_EDITION.install;

export function rememberRouterInstall(install: InstallKind): void {
  routerInstall = install;
}

export function routerInstallCopy(): InstallCopy {
  return INSTALL_COPY[routerInstall];
}
