import type { ProviderDefinitionInput } from "../../provider-definitions.ts";
import { REVIEWED_AT, vendorMcpOAuthProvider, vendorMcpToolEffects } from "./shared.ts";

/** Vendor-hosted MCP servers (revenue); pins reviewed against live discovery. */
export const REVENUE_VENDOR_MCP_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    vendorMcpOAuthProvider({
      key: "salesforce",
      displayName: "Salesforce",
      category: "crm",
      server: {
        url: "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
        resource: "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
        authorization: {
          kind: "oauth",
          issuer: "https://login.salesforce.com",
          authorizationEndpoint: "https://login.salesforce.com/services/oauth2/authorize",
          tokenEndpoint: "https://login.salesforce.com/services/oauth2/token",
          revocationEndpoint: "https://login.salesforce.com/services/oauth2/revoke",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: ["mcp_api", "refresh_token"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/hosted-mcp-servers-overview.html",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          find getObjectSchema getRelatedRecords getUserInfo listRecentSobjectRecords soqlQuery
        `,
          destructive: `deleteRelatedRecord deleteSobjectRecord`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "hubspot",
      displayName: "HubSpot",
      category: "revenue",
      server: {
        url: "https://mcp.hubspot.com/",
        resource: "https://mcp.hubspot.com",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.hubspot.com",
          authorizationEndpoint: "https://mcp.hubspot.com/oauth/authorize/user",
          tokenEndpoint: "https://mcp.hubspot.com/oauth/v3/token",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_post"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.hubspot.com/docs/build-with-ai/remote-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          discover_hubspot_schema get_aeo_metrics get_campaign_attribution_reports
          get_content_analytics_report get_conversation_channel_metadata get_crm_objects
          get_organization_details get_properties get_user_details query_crm_data
          read_campaign_data search_conversations search_crm_objects search_intent_signals
          search_owners search_properties
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "pipedrive",
      displayName: "Pipedrive",
      category: "crm",
      server: {
        url: "https://mcp.pipedrive.ai/mcp",
        resource: "https://mcp.pipedrive.ai/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://oauth.pipedrive.com",
          authorizationEndpoint: "https://oauth.pipedrive.com/oauth/authorize",
          tokenEndpoint: "https://oauth.pipedrive.com/oauth/token",
          revocationEndpoint: "https://oauth.pipedrive.com/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [
            "activities:full",
            "admin",
            "contacts:full",
            "deals:full",
            "leads:full",
            "products:full",
            "search:read",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://support.pipedrive.com/en/article/mcp-claude",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          getActivities getActivity getDeal getDeals getLead getLeadConversionStatus getLeads
          getNote getNotes getOrganization getOrganizations getPerson getPersons getProduct
          getProducts getStage getStages searchDeals searchLeads searchOrganization
          searchPersons searchProduct
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "close",
      displayName: "Close",
      category: "crm",
      server: {
        url: "https://mcp.close.com/mcp",
        resource: "https://mcp.close.com/",
        authorization: {
          kind: "oauth",
          issuer: "https://api.close.com",
          authorizationEndpoint: "https://app.close.com/oauth2/authorize/",
          tokenEndpoint: "https://api.close.com/oauth2/token/",
          revocationEndpoint: "https://api.close.com/oauth2/revoke/",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["mcp.read", "mcp.write_destructive", "mcp.write_safe", "offline_access"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.close.com/mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          activity_search fetch fetch_contact fetch_custom_activity_instance
          fetch_custom_object_instance fetch_custom_object_type fetch_invoice fetch_lead
          fetch_lead_smart_view fetch_lead_status fetch_meeting_transcript fetch_membership
          fetch_note fetch_opportunity fetch_opportunity_status
          fetch_pipeline_and_opportunity_statuses fetch_role fetch_task fetch_workflow
          find_agent_configs find_contact_custom_fields find_custom_activities
          find_custom_activity_instances find_custom_object_instances find_custom_object_types
          find_forms find_groups find_invoices find_lead_custom_fields find_lead_smart_views
          find_lead_statuses find_meeting_outcomes find_memberships find_notes
          find_opportunities find_opportunity_custom_fields
          find_pipelines_and_opportunity_statuses find_scheduling_links find_tasks
          find_voice_agents find_workflows get_ai_credit_usage get_billing_summary get_fields
          get_voice_agent_overview_report get_voice_agent_performance_report get_voice_agents
          lead_search list_membership_requests list_roles org_info paginate_search search
        `,
          destructive: `
          create_call_task delete_address delete_call_task delete_contact
          delete_custom_activity_instance delete_custom_object_instance delete_email_template
          delete_lead delete_lead_smart_view delete_lead_status delete_note delete_opportunity
          delete_opportunity_status_tool delete_pipeline delete_sms_template delete_task
          schedule_voice_agent_call
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "outreach",
      displayName: "Outreach",
      category: "sales_engagement",
      server: {
        url: "https://api.outreach.io/mcp",
        resource: "https://api.outreach.io/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://api.outreach.io",
          authorizationEndpoint: "https://api.outreach.io/mcpOAuth/authorize",
          tokenEndpoint: "https://api.outreach.io/mcpOAuth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post"],
          scopes: ["prospects.all"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.outreach.io/mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          account_get_by_id account_search account_search_by_external_id calendar_events_fetch
          emails_search filter_schema_fetch input_fields_fetch job_role_fetch kaia_meeting_fetch
          kaia_meeting_search opportunity_get_by_id opportunity_search
          opportunity_search_by_external_id opportunity_stage_fetch prospect_get_by_id
          prospect_search prospect_search_by_external_id sequence_search sequence_state_search
          stage_fetch task_priority_fetch task_search task_theme_search team_get_by_id
          team_search user_get_by_id user_search
        `,
          destructive: `
          account_delete opportunity_delete prospect_delete sequence_delete
          sequence_states_destroy
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "salesloft",
      displayName: "Salesloft",
      category: "crm",
      server: {
        url: "https://mcp.salesloft.com/mcp",
        resource: "https://mcp.salesloft.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://accounts.salesloft.com/mcp",
          authorizationEndpoint: "https://accounts.salesloft.com/oidc/authorize",
          tokenEndpoint: "https://accounts.salesloft.com/oidc/token",
          revocationEndpoint: "https://accounts.salesloft.com/oidc/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://help.salesloft.com/s/article/Salesloft-MCP-Server?language=en_US",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          search_accounts search_conversations search_opportunities search_people search_users
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "apollo",
      displayName: "Apollo",
      category: "data_enrichment",
      server: {
        url: "https://mcp.apollo.io/mcp",
        resource: "https://mcp.apollo.io/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.apollo.io",
          authorizationEndpoint: "https://mcp.apollo.io/mcp/oauth_metadata/redirect_to_authorize",
          tokenEndpoint: "https://mcp.apollo.io/api/v1/oauth/token",
          revocationEndpoint: "https://mcp.apollo.io/api/v1/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.apollo.io/docs/apollo-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          destructive: `
          apollo_emailer_campaigns_add_contact_ids
          apollo_emailer_campaigns_remove_or_stop_contact_ids
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "zoominfo",
      displayName: "ZoomInfo",
      category: "data_enrichment",
      server: {
        url: "https://mcp.zoominfo.com/mcp",
        resource: "https://mcp.zoominfo.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://okta-login.zoominfo.com/oauth2/default",
          authorizationEndpoint: "https://mcp.zoominfo.com/oauth/authorize",
          tokenEndpoint: "https://okta-login.zoominfo.com/oauth2/default/v1/token",
          revocationEndpoint: "https://okta-login.zoominfo.com/oauth2/default/v1/revoke",
          authorizationServerMetadataUrl:
            "https://mcp.zoominfo.com/.well-known/oauth-authorization-server",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "absent",
        },
        documentationUrl: "https://docs.zoominfo.com/docs/connect-to-zoominfo-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          browse_engagements find_similar_companies find_similar_contacts get_gtm_context
          get_recommended_contacts lookup search_companies search_contacts search_scoops
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "gong",
      displayName: "Gong",
      category: "revenue_intelligence",
      server: {
        url: "https://mcp.gong.io/mcp",
        resource: "https://mcp.gong.io/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.gong.io",
          authorizationEndpoint: "https://app.gong.io/oauth2/authorize",
          tokenEndpoint: "https://app.gong.io/oauth2/generate-mcp-token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: ["mcp:read", "mcp:write"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://help.gong.io/docs/about-gong-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "attio",
      displayName: "Attio",
      category: "crm",
      server: {
        url: "https://mcp.attio.com/mcp",
        resource: "https://mcp.attio.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://app.attio.com",
          authorizationEndpoint: "https://app.attio.com/oidc/authorize",
          tokenEndpoint: "https://app.attio.com/oidc/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post"],
          scopes: ["openid", "offline_access", "mcp"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.attio.com/mcp/overview",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get-note-body get-records-by-ids list-attribute-definitions list-comments
          list-list-attribute-definitions list-lists list-objects list-records
          list-records-in-list list-tasks list-workspace-members list-workspace-teams
          query-particle-sql search-emails-by-metadata search-meetings search-notes-by-metadata
          search-records semantic-search-emails semantic-search-notes whoami
        `,
          destructive: `delete-comment merge-records`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "clay",
      displayName: "Clay",
      category: "data_enrichment",
      server: {
        url: "https://api.clay.com/v3/mcp",
        resource: "https://api.clay.com/v3/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://api.clay.com",
          authorizationEndpoint: "https://app.clay.com/oauth/authorize",
          tokenEndpoint: "https://api.clay.com/oauth/token",
          revocationEndpoint: "https://api.clay.com/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["mcp"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://university.clay.com/docs/mcp-troubleshooting-and-faqs",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "crossbeam",
      displayName: "Crossbeam",
      category: "partner_ecosystem",
      server: {
        url: "https://mcp.crossbeam.com/mcp",
        resource: "https://mcp.crossbeam.com",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.crossbeam.com",
          authorizationEndpoint: "https://mcp.crossbeam.com/authorize",
          tokenEndpoint: "https://mcp.crossbeam.com/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_basic"],
          scopes: ["email", "offline_access", "openid", "profile"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://help.crossbeam.com/en/articles/12601327-crossbeam-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          find_new_accounts find_overlapping_accounts_and_leads find_overlapping_partners
          find_partner_recommendations find_partner_shared_contacts get_account_context
          get_ecosystem_activity get_partner_context get_partner_overlaps_shared_context
          get_partner_suggestions search_crossbeam_knowledge
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "partnerstack",
      displayName: "PartnerStack",
      category: "affiliate",
      server: {
        url: "https://mcp.partnerstack.com/mcp",
        resource: "https://mcp.partnerstack.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.partnerstack.com/",
          authorizationEndpoint: "https://mcp.partnerstack.com/authorize",
          tokenEndpoint: "https://mcp.partnerstack.com/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [
            "action:read",
            "action:write",
            "aeo_citation:read",
            "aeo_citation:write",
            "analytics:read",
            "application:read",
            "application:write",
            "billing:read",
            "campaign:read",
            "customer:read",
            "customer:write",
            "deal:read",
            "deal:write",
            "form_template:read",
            "group:read",
            "lead:read",
            "lead:write",
            "material:read",
            "message:read",
            "message:write",
            "partnership:read",
            "partnership:write",
            "product:read",
            "product:write",
            "product_book:read",
            "product_book:write",
            "reward:read",
            "reward:write",
            "sales_cycle:read",
            "transaction:read",
            "transaction:write",
            "webhook:read",
            "webhook:write",
            "link:read",
            "profile",
            "team:read",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://support.partnerstack.com/hc/en-us/articles/52278806189587-Connecting-PartnerStack-to-Claude",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          discover_stat_report_filters get_company_stat_report get_files_attached_to_a_deal
          get_material_engagement_analytics get_material_partner_activity
          get_material_partner_engagement list_all_actions list_all_applications
          list_all_campaigns list_all_customers list_all_deals list_all_form_templates
          list_all_groups list_all_invoices list_all_leads list_all_links
          list_all_material_folders list_all_materials list_all_partnerships list_all_rewards
          list_all_rooms list_all_transactions list_my_custom_reports retrieve_a_partner_team
          retrieve_custom_report_export retrieve_partner_team_profile
          retrieve_sales_cycle_stages
        `,
          destructive: `
          approve_or_decline_an_application convert_a_deal convert_a_lead
          updates_a_partnerships_tags
        `,
        }),
      },
    }),
  ]);
