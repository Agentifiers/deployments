import type { ProviderDefinitionInput } from "../../provider-definitions.ts";
import { REVIEWED_AT, vendorMcpOAuthProvider, vendorMcpToolEffects } from "./shared.ts";

/** Vendor-hosted MCP servers (content); pins reviewed against live discovery. */
export const CONTENT_VENDOR_MCP_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    vendorMcpOAuthProvider({
      key: "contentful",
      displayName: "Contentful",
      category: "headless_cms",
      server: {
        url: "https://mcp.contentful.com/mcp",
        resource: "https://mcp.contentful.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.contentful.com",
          authorizationEndpoint: "https://mcp.contentful.com/authorize",
          tokenEndpoint: "https://mcp.contentful.com/token",
          revocationEndpoint: "https://mcp.contentful.com/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: true,
          protectedResourceMetadata: "absent",
        },
        documentationUrl: "https://www.contentful.com/developers/docs/tools/mcp-server/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_ai_action get_ai_action_invocation get_asset get_content_type get_entry
          get_entry_preview_url get_entry_snapshot get_initial_context get_locale get_space
          get_usages list_ai_actions list_assets list_content_previews list_content_types
          list_environments list_locales list_releases list_scheduled_actions list_spaces
          list_tags search_entries semantic_search
        `,
          destructive: `
          cancel_scheduled_release delete_ai_action delete_asset delete_content_type
          delete_entry delete_environment delete_locale delete_release
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "sanity",
      displayName: "Sanity",
      category: "headless_cms",
      server: {
        url: "https://mcp.sanity.io/",
        resource: "https://mcp.sanity.io",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.sanity.io",
          authorizationEndpoint: "https://mcp.sanity.io/authorize",
          tokenEndpoint: "https://mcp.sanity.io/token",
          revocationEndpoint: "https://mcp.sanity.io/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["global"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://www.sanity.io/docs/ai/mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          cors_origins_list get_document get_project_studios get_sanity_rules get_schema
          list_datasets list_embeddings_indices list_organizations list_projects list_releases
          list_sanity_rules list_workspace_schemas query_documents read_docs search_docs
          semantic_search whoami
        `,
          destructive: `cors_origins_delete discard_drafts version_discard`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "wistia",
      displayName: "Wistia",
      category: "video",
      server: {
        url: "https://api.wistia.com/mcp/api",
        resource: "https://api.wistia.com",
        authorization: {
          kind: "oauth",
          issuer: "https://api.wistia.com",
          authorizationEndpoint: "https://api.wistia.com/oauth/authorize",
          tokenEndpoint: "https://api.wistia.com/oauth/token",
          revocationEndpoint: "https://api.wistia.com/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [
            "all:read",
            "all:delegate_to_contact_permissions",
            "all:all",
            "media:read",
            "media:upload",
            "project:write",
            "stats:read",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.wistia.com/docs/mcp-server-guide",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "heygen",
      displayName: "HeyGen",
      category: "video",
      server: {
        url: "https://mcp.heygen.com/mcp/v1/",
        resource: "https://mcp.heygen.com/mcp/v1",
        authorization: {
          kind: "oauth",
          issuer: "https://api2.heygen.com",
          authorizationEndpoint: "https://api2.heygen.com/v1/oauth/authorize",
          tokenEndpoint: "https://api2.heygen.com/v1/oauth/token",
          revocationEndpoint: "https://api2.heygen.com/v1/oauth/revoke",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["openid", "profile", "email"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.heygen.com/mcp/overview",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_ai_clipping get_asset get_avatar_group get_avatar_look get_brand_glossary
          get_brand_kit get_current_user get_filler_word_removal get_folder get_lipsync
          get_model_audio_voice get_model_video get_template get_video get_video_agent_resource
          get_video_agent_session get_video_scenes get_video_translation get_voice
          list_ai_clipping list_assets list_avatar_groups list_avatar_looks
          list_brand_glossaries list_brand_kits list_lipsyncs list_look_templates
          list_model_audio_voices list_templates list_video_agent_session_videos
          list_video_agent_sessions list_video_agent_styles list_video_translation_languages
          list_video_translations list_videos list_voices search_audio_sounds
        `,
          destructive: `
          delete_ai_clipping delete_asset delete_avatar_group delete_avatar_look
          delete_brand_glossary delete_brand_kit delete_lipsync delete_model_audio_voice
          delete_video delete_video_translation delete_voice stop_video_agent_session
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "livestorm",
      displayName: "Livestorm",
      category: "webinar",
      server: {
        url: "https://mcp.livestorm.co/mcp",
        resource: "https://mcp.livestorm.co/",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.livestorm.co/",
          authorizationEndpoint: "https://mcp.livestorm.co/authorize",
          tokenEndpoint: "https://mcp.livestorm.co/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post"],
          scopes: ["full:read", "full:write"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.livestorm.co/docs/model-context-protocol-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "webflow",
      displayName: "Webflow",
      category: "marketing",
      server: {
        url: "https://mcp.webflow.com/mcp",
        resource: "https://mcp.webflow.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.webflow.com",
          authorizationEndpoint: "https://mcp.webflow.com/oauth/authorize",
          tokenEndpoint: "https://mcp.webflow.com/oauth/token",
          revocationEndpoint: "https://mcp.webflow.com/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.webflow.com/mcp/reference/overview.md",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `data_analyze_tool get_asset_preview get_more_tools`,
          destructive: `
          data_agent_instructions_tool data_apps_tool data_assets_tool data_campaigns_tool
          data_cms_tool data_component_props_tool data_component_tool
          data_component_variants_tool data_element_tool data_enterprise_tool data_fonts_tool
          data_forms_tool data_interactions_tool data_pages_tool data_scripts_tool
          data_style_tool data_variable_tool data_webhook_tool
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "wordpress_com",
      displayName: "WordPress.com",
      category: "content",
      server: {
        url: "https://public-api.wordpress.com/wpcom/v2/mcp/v1",
        resource: "https://public-api.wordpress.com/wpcom/v2/mcp/v1",
        authorization: {
          kind: "oauth",
          issuer: "https://public-api.wordpress.com",
          authorizationEndpoint: "https://public-api.wordpress.com/oauth2-1/authorize",
          tokenEndpoint: "https://public-api.wordpress.com/oauth2-1/token",
          revocationEndpoint: "https://public-api.wordpress.com/oauth2-1/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [
            "global",
            "auth",
            "openid",
            "profile",
            "email",
            "users",
            "sites",
            "posts",
            "comments",
            "taxonomy",
            "follow",
            "sharing",
            "freshly-pressed",
            "notifications",
            "insights",
            "read",
            "stats",
            "media",
            "menus",
            "batch",
            "videos",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.wordpress.com/docs/mcp/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `wpcom-plans-list`,
          destructive: `
          wpcom-domain-restore-default-dns-records wpcom-domain-set-mail-service
          wpcom-domain-update-dns-records wpcom-domain-update-nameservers wpcom-mcp-account
          wpcom-mcp-content-authoring wpcom-mcp-plugin-management wpcom-mcp-site-editing
          wpcom-mcp-user-management
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "typeform",
      displayName: "Typeform",
      category: "forms",
      server: {
        url: "https://api.typeform.com/mcp",
        resource: "https://api.typeform.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://api.typeform.com",
          authorizationEndpoint: "https://admin.typeform.com/oauth/authorize",
          tokenEndpoint: "https://api.typeform.com/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [
            "accounts:read",
            "automations:read",
            "automations:write",
            "contacts:read",
            "contacts:write",
            "forms:read",
            "forms:write",
            "pages:read",
            "pages:write",
            "responses:read",
            "responses:write",
            "insights:read",
            "webhooks:read",
            "webhooks:write",
            "workspaces:read",
            "workspaces:write",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://www.typeform.com/developers/mcp/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          accounts-list_accounts automations-public_get_automation
          automations-public_list_automations automations-public_list_referenceable_fields
          contacts-public_get_contact contacts-public_get_contacts_database_properties
          contacts-public_get_contacts_list contacts-public_get_form_property_compatibility
          contacts-public_get_form_property_mappings
          contacts-public_get_form_property_mappings_by_id contacts-public_list_contacts
          contacts-public_list_contacts_database_properties contacts-public_list_contacts_lists
          contacts-public_list_form_property_mappings forms-public_get_capabilities
          forms-public_get_form forms-public_list_forms insights-public_discover
          insights-public_list themes-get_theme themes-public_list_themes
          workspaces-list_workspaces
        `,
          destructive: `
          contacts-public_delete_contact contacts-public_delete_contacts_database_properties
          contacts-public_delete_contacts_database_property contacts-public_delete_contacts_list
          contacts-public_delete_form_property_mappings forms-public_delete_form
          themes-update_theme
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "surveymonkey",
      displayName: "SurveyMonkey",
      category: "content",
      server: {
        url: "https://mcp.surveymonkey.com/mcp",
        resource: "https://mcp.surveymonkey.com",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.surveymonkey.com",
          authorizationEndpoint: "https://mcp.surveymonkey.com/authorize",
          tokenEndpoint: "https://mcp.surveymonkey.com/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post"],
          scopes: [
            "surveys_read",
            "surveys_write",
            "collectors_write",
            "responses_read",
            "responses_read_detail",
            "users_read",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://help.surveymonkey.com/en/surveymonkey/integrations/claude-app/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_page get_pages get_question get_question_types get_questions get_response_count
          get_response_summary get_responses get_server_info get_survey search_surveys
        `,
          destructive: `delete_question`,
        }),
      },
    }),
  ]);
