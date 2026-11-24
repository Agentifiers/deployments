import type { SlackDataVisualizationChartType } from "./data-visualization.ts";

export interface ProviderSlackVisualizationChartCapability {
  blockId: string;
  chartType: SlackDataVisualizationChartType;
  dataShape: string;
}

export interface ProviderSlackVisualizationCapability {
  charts: readonly ProviderSlackVisualizationChartCapability[];
  displayName: string;
  provider: string;
  toolNames: readonly string[];
}

export const PROVIDER_SLACK_VISUALIZATION_CAPABILITIES = [
  {
    charts: [
      {
        blockId: "deployments-ai-google-ads-campaigns",
        chartType: "bar",
        dataShape: "campaign conversions, clicks, or spend ranked by campaign",
      },
    ],
    displayName: "Google Ads",
    provider: "google_ads",
    toolNames: ["google_ads.campaign_report"],
  },
  {
    charts: [
      {
        blockId: "deployments-ai-quickbooks-report",
        chartType: "bar",
        dataShape: "QuickBooks report row amounts",
      },
    ],
    displayName: "QuickBooks",
    provider: "quickbooks",
    toolNames: ["quickbooks.reports.read"],
  },
  {
    charts: [
      {
        blockId: "deployments-ai-zendesk-tickets",
        chartType: "pie",
        dataShape: "ticket counts grouped by status, priority, or type",
      },
    ],
    displayName: "Zendesk",
    provider: "zendesk",
    toolNames: ["zendesk.tickets.search"],
  },
] as const satisfies readonly ProviderSlackVisualizationCapability[];
