import type { ProviderDefinitionInput } from "../../provider-definitions.ts";
import {
  REVIEWED_AT,
  vendorMcpApiKeyProvider,
  vendorMcpOAuthProvider,
  vendorMcpToolEffects,
} from "./shared.ts";

/** Vendor-hosted MCP servers (support); pins reviewed against live discovery. */
export const SUPPORT_VENDOR_MCP_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    vendorMcpOAuthProvider({
      key: "intercom",
      displayName: "Intercom",
      category: "messaging",
      server: {
        url: "https://mcp.intercom.com/mcp",
        resource: "https://mcp.intercom.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.intercom.com",
          authorizationEndpoint: "https://mcp.intercom.com/authorize",
          tokenEndpoint: "https://mcp.intercom.com/token",
          revocationEndpoint: "https://mcp.intercom.com/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "absent",
        },
        documentationUrl: "https://developers.intercom.com/docs/guides/mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          fetch get_article get_company get_contact get_conversation list_articles
          list_companies search search_articles search_contacts search_conversations
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "front",
      displayName: "Front",
      category: "operations",
      server: {
        url: "https://mcp.frontapp.com/mcp",
        resource: "https://mcp.frontapp.com",
        authorization: {
          kind: "oauth",
          issuer: "https://app.frontapp.com",
          authorizationEndpoint: "https://app.frontapp.com/oauth/authorize",
          tokenEndpoint: "https://app.frontapp.com/oauth/token",
          revocationEndpoint: "https://app.frontapp.com/oauth/revoke",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://dev.frontapp.com/docs/mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_attachment get_my_identity list_channels list_drafts list_inboxes list_statuses
          list_tags list_teammates list_teams read_account read_contact read_conversation
          search_accounts search_contacts search_conversations
        `,
          destructive: `delete_draft send_message`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "help_scout",
      displayName: "Help Scout",
      category: "support",
      server: {
        url: "https://mcp.helpscout.net/mcp",
        resource: "https://mcp.helpscout.net/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.helpscout.net",
          authorizationEndpoint: "https://mcp.helpscout.net/oauth/authorize",
          tokenEndpoint: "https://mcp.helpscout.net/oauth/token",
          revocationEndpoint: "https://mcp.helpscout.net/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post"],
          scopes: ["helpscout"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://docs.helpscout.com/article/1779-connect-your-ai-agent-with-help-scout-to-search-conversations-and-pull-reports",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "gorgias",
      displayName: "Gorgias",
      category: "support",
      server: {
        url: "https://mcp.gorgias.com/mcp",
        resource: "https://mcp.gorgias.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.gorgias.com/",
          authorizationEndpoint: "https://mcp.gorgias.com/authorize",
          tokenEndpoint: "https://mcp.gorgias.com/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: [
            "openid",
            "email",
            "profile",
            "offline",
            "account:read",
            "account:write",
            "users:read",
            "users:write",
            "customers:read",
            "customers:write",
            "tickets:read",
            "tickets:write",
            "custom_fields:read",
            "custom_fields:write",
            "events:read",
            "integrations:read",
            "integrations:write",
            "jobs:read",
            "jobs:write",
            "macros:read",
            "macros:write",
            "rules:read",
            "rules:write",
            "routines:read",
            "routines:write",
            "satisfaction_survey:read",
            "satisfaction_survey:write",
            "statistics:read",
            "tags:read",
            "tags:write",
            "apps:read",
            "apps:write",
            "help_center:read",
            "help_center:write",
            "ecommerce:read",
            "ecommerce:write",
            "billing:read",
          ],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://docs.gorgias.com/en-US/connect-your-ai-assistant-to-the-gorgias-mcp-6310546",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_action_template get_agent_configuration get_ai_agent_preview_session
          get_ai_reasoning get_current_user get_custom_field get_customer get_gaia_instructions
          get_guidance get_help_center_article get_help_center_extra_html get_help_center_theme
          get_http_integration get_instruction get_job get_macro get_opportunity
          get_product_custom_info get_reporting_stats get_reporting_stats_schema get_routine
          get_rule get_skill get_snippet get_snippet_source get_support_action
          get_support_action_execution get_table_metadata get_tables get_team get_ticket
          get_view get_view_section get_widget list_action_templates list_agent_configurations
          list_ai_agent_preview_options list_custom_fields list_customers
          list_guidance_templates list_guidances list_help_center_articles
          list_help_center_categories list_help_centers list_http_integration_logs
          list_http_integrations list_integrations list_intents list_macros list_metric_cards
          list_opportunities list_product_metafield_definitions list_routine_runs list_routines
          list_rule_audit_events list_rules list_skills list_snippet_sources list_snippets
          list_support_action_executions list_support_actions list_tags list_teams list_tickets
          list_users list_view_sections list_views list_voice_queues list_widgets
          preview_tone_of_voice query search_products search_tickets
        `,
          destructive: `
          convert_to_advanced_view create_message create_ticket delete_routine
          delete_support_action delete_view delete_view_section delete_widget
          discard_draft_guidance discard_help_center_article_draft reply_and_close
          trigger_routine
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "servicenow",
      displayName: "ServiceNow",
      category: "operations",
      server: {
        url: "https://{tenant}.service-now.com/sncapps/mcp-server/mcp/sn_mcp_server_default",
        tenant: { label: "ServiceNow instance name", hostSuffixes: ["service-now.com"] },
        resource: "https://{tenant}.service-now.com/sncapps/mcp-server/mcp/sn_mcp_server_default",
        authorization: {
          kind: "oauth",
          issuer: "https://{tenant}.service-now.com",
          authorizationEndpoint: "https://{tenant}.service-now.com/oauth_auth.do",
          tokenEndpoint: "https://{tenant}.service-now.com/oauth_token.do",
          revocationEndpoint: "https://{tenant}.service-now.com/oauth_revoke.do",
          registrationMethods: ["pre_registered", "client_id_metadata_document"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "absent",
        },
        documentationUrl:
          "https://www.servicenow.com/docs/r/intelligent-experiences/enable-ai-experiences/connect-mcp-server-client.html",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `lookup_case_records lookup_incident_records`,
        }),
      },
    }),
    vendorMcpApiKeyProvider({
      key: "freshdesk",
      displayName: "Freshdesk",
      category: "support",
      server: {
        url: "https://{tenant}.freshdesk.com/mcp",
        tenant: { label: "Freshdesk subdomain", hostSuffixes: ["freshdesk.com"] },
        resource: "https://{tenant}.freshdesk.com/mcp",
        authorization: { kind: "api_key", field: "apiKey", headerName: "authorization" },
        documentationUrl:
          "https://support.freshdesk.com/support/solutions/articles/50000012670-model-context-protocol-mcp-integration-in-freshdesk-eap-",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
  ]);
