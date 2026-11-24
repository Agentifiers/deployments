import type { ProviderDefinitionInput } from "../../provider-definitions.ts";
import { REVIEWED_AT, vendorMcpOAuthProvider, vendorMcpToolEffects } from "./shared.ts";

/** Vendor-hosted MCP servers (analytics); pins reviewed against live discovery. */
export const ANALYTICS_VENDOR_MCP_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    vendorMcpOAuthProvider({
      key: "mixpanel",
      displayName: "Mixpanel",
      category: "analytics",
      server: {
        url: "https://mcp.mixpanel.com/mcp",
        resource: "https://mcp.mixpanel.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.mixpanel.com/mcp",
          authorizationEndpoint: "https://mixpanel.com/oauth/authorize",
          tokenEndpoint: "https://mixpanel.com/oauth/token/",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [
            "projects",
            "analysis",
            "events",
            "insights",
            "segmentation",
            "retention",
            "data:read",
            "funnels",
            "flows",
            "data_definitions",
            "alerts",
            "annotations",
            "bookmarks",
            "business_context",
            "cohorts",
            "context",
            "custom_alerts",
            "custom_events",
            "custom_properties",
            "dashboard_reports",
            "experiments",
            "feature_flags",
            "metrics",
            "user_details",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.mixpanel.com/docs/mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          Describe-Cohort-Schema Display-Query Explain-Experiment-Health-Check
          Get-Business-Context Get-Cohort Get-Custom-Property Get-Dashboard Get-Events
          Get-Experiment Get-Experiment-Results-Interpretation-Guidance
          Get-Experiment-Setup-Guidance Get-Feature-Flag Get-Feature-Flag-Lifecycle-Guidance
          Get-Feature-Flag-Setup-Guidance Get-Issues Get-Lexicon-URL Get-Lookup-Table Get-Metric
          Get-Projects Get-Property-Values Get-Query-Schema Get-Report Get-User-Replays-Data
          List-Cohorts List-Dashboards List-Experiments List-Feature-Flags List-Metrics
          List-Organizations List-Properties Search-Entities Search-Prior-Experiments
        `,
          destructive: `Delete-Cohort Delete-Dashboard Delete-Tag Merge-Group`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "amplitude",
      displayName: "Amplitude",
      category: "analytics",
      server: {
        url: "https://mcp.amplitude.com/mcp",
        resource: "https://mcp.amplitude.com",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.amplitude.com",
          authorizationEndpoint: "https://mcp.amplitude.com/authorize",
          tokenEndpoint: "https://mcp.amplitude.com/token",
          revocationEndpoint: "https://mcp.amplitude.com/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post"],
          scopes: ["mcp:read", "mcp:write"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://amplitude.com/docs/amplitude-ai/amplitude-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          describe_tool get_agent_results get_amp_taxonomy get_amp_user_data
          get_amplitude_agent_analytics_info get_amplitude_charts get_amplitude_context
          get_category_tools get_data_ingestion_sources get_data_source_details
          get_data_warehouse_destinations get_data_warehouse_jobs get_deployments
          get_experiments get_flags get_from_url get_group_types get_guide_or_survey
          get_session_replay_events get_session_replays get_transformations list_guides_surveys
          list_session_replays list_tool_categories query_amplitude_data query_experiment
          query_wave_opportunities query_wave_product_areas search
        `,
          destructive: `manage_amp_events manage_amp_properties manage_amp_taxonomy`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "pendo",
      displayName: "Pendo",
      category: "product_analytics",
      server: {
        url: "https://app.pendo.io/mcp/v0/shttp",
        resource: "https://app.pendo.io/mcp/v0/shttp",
        authorization: {
          kind: "oauth",
          issuer: "https://app.pendo.io",
          authorizationEndpoint: "https://app.pendo.io/oauth/authorize",
          tokenEndpoint: "https://app.pendo.io/oauth/v1/token",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post"],
          scopes: ["mcp:tools", "mcp:resources"],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://support.pendo.io/hc/en-us/articles/41102236924955-Connect-to-the-Pendo-MCP-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          getEntity getFeedbackInsights getFeedbackItems getIdeas getOrchestrateJourney
          getOrchestrateJourneyMetrics getOrchestrateJourneyStepMetrics
          getOrchestrateJourneyStepVisitors getOrchestrateJourneySteps getSegment listAccounts
          listAiAgentIssues listAiAgents listAllApplications listBusinessObjectMetadata
          listCountables listCustomObjects listGuideCategories listGuideExperiments
          listGuideOrdering listGuides listOrchestrateEmails listOrchestrateJourneyTemplates
          listOrchestrateJourneys listProductAreas listSurveys listTrackedIssues
          listTrackedUseCases listUseCases listVisitors queryFunnel resolveBusinessObject
          searchEntities segmentList sessionReplayList sessionReplaySummarize
        `,
          destructive: `deleteSegment`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "optimizely",
      displayName: "Optimizely",
      category: "ab_testing",
      server: {
        url: "https://exp.mcp.opal.optimizely.com/mcp",
        resource: "https://exp.mcp.opal.optimizely.com",
        authorization: {
          kind: "oauth",
          issuer: "https://auth.mcp.opal.optimizely.com",
          authorizationEndpoint: "https://auth.mcp.opal.optimizely.com/oauth/authorize",
          tokenEndpoint: "https://auth.mcp.opal.optimizely.com/oauth/token",
          revocationEndpoint: "https://auth.mcp.opal.optimizely.com/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["mcp:tools"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://support.optimizely.com/hc/en-us/articles/45320607594893-Optimizely-Experimentation-MCP-server-overview",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          exp_get_entity_templates exp_get_schemas exp_search_fx_sdk_docs
          exp_summarize_test_result
        `,
          destructive: `exp_manage_entity_lifecycle`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "adobe_analytics",
      displayName: "Adobe Analytics",
      category: "analytics",
      server: {
        url: "https://aa-mcp.adobe.io/mcp",
        resource: "https://aa-mcp.adobe.io/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://aa-mcp.adobe.io",
          authorizationEndpoint: "https://ims-na1.adobelogin.com/ims/authorize/v2",
          tokenEndpoint: "https://ims-na1.adobelogin.com/ims/token/v3",
          revocationEndpoint: "https://ims-na1.adobelogin.com/ims/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["openid", "AdobeID", "additional_info.projectedProductContext"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.adobe.com/analytics-mcp/docs/guides/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          describeAa findCompanies findDateRanges findDimensions findMetrics findReportSuites
          findSegments getDefaultSessionReportSuiteId listComponentUsage listFrequentlyUsedWith
          listSimilarTo searchDimensionItems
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "tableau",
      displayName: "Tableau",
      category: "analytics",
      server: {
        url: "https://mcp.tableau.com",
        resource: "https://mcp.tableau.com",
        authorization: {
          kind: "oauth",
          issuer: "https://sso.online.tableau.com",
          authorizationEndpoint: "https://sso.online.tableau.com/oauth2/authorize",
          tokenEndpoint: "https://sso.online.tableau.com/oauth2/token",
          revocationEndpoint: "https://sso.online.tableau.com/oauth2/revoke",
          registrationMethods: ["pre_registered", "client_id_metadata_document"],
          tokenEndpointAuthMethods: ["none"],
          scopes: [
            "tableau:mcp:datasource:read",
            "tableau:mcp:workbook:read",
            "tableau:mcp:view:read",
            "tableau:mcp:view:download",
            "tableau:mcp:pulse:read",
            "tableau:mcp:insight:create",
            "tableau:mcp:content:read",
            "tableau:mcp:knowledge:read",
            "tableau:mcp:knowledge:write",
            "tableau:content:read",
            "tableau:mcp_site_settings:read",
            "tableau:viz_data_service:read",
            "tableau:views:download",
            "tableau:insight_definitions_metrics:read",
            "tableau:insight_metrics:read",
            "tableau:metric_subscriptions:read",
            "tableau:insights:read",
            "tableau:insight_brief:create",
            "tableau:mcp:workbook:create",
            "tableau:workbooks:download",
            "tableau:workbooks:create",
            "tableau:file_uploads:create",
            "tableau:knowledge:read",
            "tableau:knowledge:write",
            "tableau:entitlements:read",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://tableau.github.io/tableau-mcp/docs/hosted-tableau-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "ga4",
      displayName: "Google Analytics 4",
      category: "data",
      server: {
        url: "https://analyticsdata.googleapis.com/mcp/v1",
        resource: "https://analyticsdata.googleapis.com/mcp/v1",
        authorization: {
          kind: "oauth",
          issuer: "https://accounts.google.com",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          revocationEndpoint: "https://oauth2.googleapis.com/revoke",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [
            "https://www.googleapis.com/auth/analytics.readonly",
            "https://www.googleapis.com/auth/analytics",
          ],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://github.com/googleanalytics/google-analytics-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          check_compatibility get_account get_data_retention_settings get_metadata get_property
          list_account_summaries list_accounts list_custom_dimensions list_custom_metrics
          list_data_streams list_google_ads_links list_key_events list_properties
          list_reporting_data_annotations
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "supermetrics",
      displayName: "Supermetrics",
      category: "data_aggregation",
      server: {
        url: "https://mcp.supermetrics.com/mcp",
        resource: "https://mcp.supermetrics.com/",
        authorization: {
          kind: "oauth",
          issuer: "https://api.supermetrics.com",
          authorizationEndpoint: "https://api.supermetrics.com/oauth/authorize",
          tokenEndpoint: "https://api.supermetrics.com/oauth/token",
          revocationEndpoint: "https://api.supermetrics.com/oauth/revoke",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [
            "team_read",
            "user_read",
            "ds_logins_read",
            "ds_accounts_read",
            "ds_queries_run",
            "openid",
            "offline_access",
            "auth_create_account",
            "ds_login_links_read",
            "ds_login_links_write",
            "ds_platform_write",
            "business_context_read",
            "business_context_write",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://mcp.supermetrics.com/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `data_query get_async_query_results get_today`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "coupler",
      displayName: "Coupler.io",
      category: "analytics",
      server: {
        url: "https://mcp.coupler.io/mcp",
        resource: "https://mcp.coupler.io/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://auth.coupler.io/",
          authorizationEndpoint: "https://auth.coupler.io/oauth2/authorize",
          tokenEndpoint: "https://auth.coupler.io/oauth2/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["mcp"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://github.com/railsware/coupler-io-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get-data get-dataflow get-schema list-dataflows list-datasets list-templates
          search-datasets
        `,
        }),
      },
    }),
  ]);
