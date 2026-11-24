import type { ProviderDefinitionInput } from "../../provider-definitions.ts";
import { REVIEWED_AT, vendorMcpOAuthProvider, vendorMcpToolEffects } from "./shared.ts";

/** Vendor-hosted MCP servers (growth); pins reviewed against live discovery. */
export const GROWTH_VENDOR_MCP_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    vendorMcpOAuthProvider({
      key: "exa",
      displayName: "Exa",
      category: "ai_search",
      server: {
        url: "https://mcp.exa.ai/mcp",
        resource: "https://mcp.exa.ai/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://auth.exa.ai",
          authorizationEndpoint: "https://auth.exa.ai/oauth/authorize",
          tokenEndpoint: "https://auth.exa.ai/api/oauth/token",
          revocationEndpoint: "https://auth.exa.ai/api/oauth/revoke",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["mcp:tools"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.exa.ai/reference/exa-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `web_fetch_exa web_search_exa`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "airops",
      displayName: "AirOps",
      category: "ai_content",
      server: {
        url: "https://app.airops.com/mcp",
        resource: "https://app.airops.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://app.airops.com",
          authorizationEndpoint: "https://app.airops.com/oauth/web/authorize",
          tokenEndpoint: "https://app.airops.com/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post"],
          scopes: ["api"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.airops.com/developers/mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_aeo_ad get_aeo_citation get_aeo_prompt_assignments_status get_answer get_brand_kit
          get_grid_row_execution_status get_insights_settings get_page_details get_page_prompts
          get_prompt_answers get_report get_sentiment_theme_answers knowledge_base_get_document
          knowledge_base_get_status list_aeo_ads list_aeo_advertisers list_aeo_citations
          list_aeo_domains list_aeo_prompts list_answers list_brand_kits list_grids
          list_knowledge_bases list_pages list_personas list_reports list_tags list_topics
          list_workspaces query_analytics read_grid read_grid_cell search_knowledge_base
        `,
          destructive: `
          delete_aeo_tag delete_grid_column delete_topic discard_aeo_prompt_assignments
          knowledge_base_delete knowledge_base_delete_document
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "snov",
      displayName: "Snov.io",
      category: "email_outreach",
      server: {
        url: "https://mcp.snov.io/mcp",
        resource: "https://mcp.snov.io/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://app.snov.io",
          authorizationEndpoint: "https://app.snov.io/mcp/authorize",
          tokenEndpoint: "https://app.snov.io/back/mcp/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["mcp"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://snov.io/knowledgebase/how-to-use-snov-io-mcp-with-your-ai-assistant/",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "hunter",
      displayName: "Hunter",
      category: "email_outreach",
      server: {
        url: "https://mcp.hunter.io/mcp",
        resource: "https://mcp.hunter.io",
        authorization: {
          kind: "oauth",
          issuer: "https://hunter.io",
          authorizationEndpoint: "https://hunter.io/oauth/authorize",
          tokenEndpoint: "https://hunter.io/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["read", "write"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://hunter.io/api-documentation",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "instantly",
      displayName: "Instantly",
      category: "email_outreach",
      server: {
        url: "https://mcp.instantly.ai/mcp",
        resource: "https://mcp.instantly.ai",
        authorization: {
          kind: "oauth",
          issuer: "https://api.instantly.ai",
          authorizationEndpoint: "https://api.instantly.ai/oauth/authorize",
          tokenEndpoint: "https://api.instantly.ai/oauth/token",
          revocationEndpoint: "https://api.instantly.ai/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.instantly.ai/mcp/introduction",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `get_campaign_analytics list_accounts list_campaigns`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "lemlist",
      displayName: "Lemlist",
      category: "email_outreach",
      server: {
        url: "https://app.lemlist.com/mcp",
        resource: "https://app.lemlist.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://app.lemlist.com",
          authorizationEndpoint: "https://app.lemlist.com/oauth/authorize",
          tokenEndpoint: "https://app.lemlist.com/oauth/token",
          revocationEndpoint: "https://app.lemlist.com/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post"],
          scopes: ["full_access"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.lemlist.com/mcp/setup",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `get_campaign_stats get_campaigns lemleads_search`,
          destructive: `call_api`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "sparktoro",
      displayName: "SparkToro",
      category: "audience_research",
      server: {
        url: "https://mcp.sparktoro.com/mcp",
        resource: "https://mcp.sparktoro.com",
        authorization: {
          kind: "oauth",
          issuer: "https://sparktoro.com",
          authorizationEndpoint: "https://sparktoro.com/oauth/authorize",
          tokenEndpoint: "https://sparktoro.com/oauth/token",
          revocationEndpoint: "https://sparktoro.com/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["mcp"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://sparktoro.com/mcp/docs",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_apps get_bio_keywords get_demographics get_keywords get_networks get_new_podcasts
          get_press get_prompts get_reddit get_report_status get_social get_tam get_websites
          get_youtube list_reports
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "keywords_everywhere",
      displayName: "Keywords Everywhere",
      category: "seo",
      server: {
        url: "https://mcp.keywordseverywhere.com/mcp",
        resource: "https://mcp.keywordseverywhere.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.keywordseverywhere.com",
          authorizationEndpoint: "https://mcp.keywordseverywhere.com/oauth/authorize",
          tokenEndpoint: "https://mcp.keywordseverywhere.com/oauth/token",
          revocationEndpoint: "https://mcp.keywordseverywhere.com/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["default"],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://mcp.keywordseverywhere.com/docs",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_countries get_credit_balance get_currencies get_domain_backlinks
          get_domain_keywords get_domain_traffic_metrics get_keyword_data get_page_backlinks
          get_pasf_keywords get_related_keywords get_unique_domain_backlinks
          get_unique_page_backlinks get_url_keywords get_url_traffic_metrics
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "truelist",
      displayName: "Truelist",
      category: "email_verification",
      server: {
        url: "https://api.truelist.io/mcp",
        resource: "https://api.truelist.io/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://api.truelist.io",
          authorizationEndpoint: "https://api.truelist.io/oauth/authorize",
          tokenEndpoint: "https://api.truelist.io/oauth/token",
          revocationEndpoint: "https://api.truelist.io/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["mcp"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://truelist.io/docs/sdks/mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `check_account list_batches`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "introw",
      displayName: "Introw",
      category: "partner_ecosystem",
      server: {
        url: "https://app.introw.io/api/mcp",
        resource: "https://app.introw.io/api/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://app.introw.io/api/mcp",
          authorizationEndpoint: "https://app.introw.io/api/mcp/oauth/authorize",
          tokenEndpoint: "https://app.introw.io/api/mcp/oauth/token",
          revocationEndpoint: "https://app.introw.io/api/mcp/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.introw.io/features/developer/mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          find_relevant_content get_goals get_tier_information list_asset_folders list_assets
          list_certificates list_course_enrollments list_courses list_issued_certificates
          search_commissions search_crm_objects search_form_submissions
          search_partner_engagement search_partners search_tasks
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "semrush",
      displayName: "Semrush",
      category: "seo",
      server: {
        url: "https://mcp.semrush.com/v2/mcp",
        resource: "https://mcp.semrush.com/v2/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://oauth.semrush.com",
          authorizationEndpoint: "https://api.semrush.com/apis/v4/auth/v0/oauth2/auth",
          tokenEndpoint: "https://api.semrush.com/apis/v4-raw/auth/v1/oauth2/access_token",
          revocationEndpoint: "https://api.semrush.com/apis/v4/auth/v1/oauth2/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["mcp.access"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.semrush.com/api/v4/introduction/semrush-mcp/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `domain_overview get_report_schema paid_search_research traffic_overview`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "ahrefs",
      displayName: "Ahrefs",
      category: "seo",
      server: {
        url: "https://api.ahrefs.com/mcp/mcp",
        resource: "https://api.ahrefs.com/",
        authorization: {
          kind: "oauth",
          issuer: "https://api.ahrefs.com/",
          authorizationEndpoint: "https://app.ahrefs.com/web/oauth/authorize",
          tokenEndpoint: "https://ahrefs.com/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.ahrefs.com/en/mcp/docs/introduction",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          gsc-keyword-history gsc-page-history gsc-pages-history gsc-performance-history
          gsc-positions-history keywords-explorer-overview keywords-explorer-search-suggestions
          management-keyword-list-keywords rank-tracker-overview serp-overview-serp-overview
          subscription-info-limits-and-usage web-analytics-stats
        `,
          destructive: `
          management-brand-radar-prompts-delete management-keyword-list-keywords-delete
          management-project-competitors-delete management-project-keywords-delete
          management-project-keywords-tags-delete
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "similarweb",
      displayName: "Similarweb",
      category: "competitive_intelligence",
      server: {
        url: "https://mcp.similarweb.com/mcp",
        resource: "https://mcp.similarweb.com",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp-auth.similarweb.com",
          authorizationEndpoint: "https://mcp-auth.similarweb.com/authorize",
          tokenEndpoint: "https://mcp-auth.similarweb.com/token",
          revocationEndpoint: "https://mcp-auth.similarweb.com/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["read"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.similarweb.com/docs/similarweb-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "dataforseo",
      displayName: "DataForSEO",
      category: "marketing",
      server: {
        url: "https://mcp.dataforseo.com/v3/mcp",
        resource: "https://mcp.dataforseo.com",
        authorization: {
          kind: "oauth",
          issuer: "https://data.dataforseo.com",
          authorizationEndpoint: "https://data.dataforseo.com/oauth/authorize",
          tokenEndpoint: "https://data.dataforseo.com/oauth/token",
          revocationEndpoint: "https://data.dataforseo.com/oauth/tokens/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["api"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://github.com/dataforseo/mcp-server-typescript",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `docs_list_sections docs_search`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "meta_ads",
      displayName: "Meta Ads",
      category: "marketing",
      server: {
        url: "https://mcp.facebook.com/ads",
        resource: "https://mcp.facebook.com/ads",
        authorization: {
          kind: "oauth",
          issuer: "https://www.facebook.com/ads",
          authorizationEndpoint: "https://www.facebook.com/v26.0/dialog/oauth",
          tokenEndpoint: "https://graph.facebook.com/v26.0/oauth/access_token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: [
            "ads_management",
            "ads_read",
            "catalog_management",
            "business_management",
            "pages_show_list",
            "pages_manage_ads",
            "instagram_basic",
            "ads_mcp_management",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-overview",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          ads_account_get_activity_logs ads_catalog_get_catalogs ads_catalog_get_data_sources
          ads_catalog_get_details ads_catalog_get_diagnostics ads_catalog_get_dynamic_ads_health
          ads_catalog_get_feed_rules ads_catalog_get_product_details
          ads_catalog_get_product_feed_details ads_catalog_get_product_product_sets
          ads_catalog_get_product_sets ads_catalog_search_product
          ads_experiment_check_eligibility ads_experiment_list_tests
          ads_get_ad_account_custom_audiences ads_get_ad_account_pages ads_get_ad_accounts
          ads_get_ad_entities ads_get_ad_images ads_get_ad_preview ads_get_ad_videos
          ads_get_creative_ads ads_get_creatives ads_get_custom_audience
          ads_get_custom_audience_adsets ads_get_customconversions ads_get_dataset_details
          ads_get_dataset_quality ads_get_dataset_stats ads_get_datasets ads_get_errors
          ads_get_field_context ads_get_help_article ads_get_ig_accounts ads_get_ig_media
          ads_get_opportunity_score ads_get_pages_for_business ads_get_user_pages
          ads_library_search
        `,
          destructive: `
          ads_activate_entity ads_boost_ig_post ads_catalog_delete_product
          ads_catalog_event_source_disconnect ads_catalog_product_feed_delete
          ads_catalog_product_feed_delete_rule ads_catalog_product_set_delete
          ads_delete_custom_audience ads_experiment_abtest_update_test ads_pixel_event_delete
          ads_pixel_parameter_delete ads_update_custom_audience_users
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "tiktok_ads",
      displayName: "TikTok Ads",
      category: "ads",
      server: {
        url: "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat",
        resource: "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat",
        authorization: {
          kind: "oauth",
          issuer: "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat/oauth",
          authorizationEndpoint: "https://business-api.tiktok.com/portal/mcp-tt4b-authorize",
          tokenEndpoint: "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat/oauth/token",
          revocationEndpoint:
            "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["mcp:tt4b"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://business-api.tiktok.com/portal/docs/tiktok-ads-mcp-server/v1.3",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          ad_get ad_review_info_get adgroup_get adgroup_quota_get adgroup_review_info_get
          advertiser_balance_get advertiser_info_get advertiser_transaction_get app_info_get
          app_list_get audience_insight_info_get auth_advertiser_get bc_asset_get bc_balance_get
          bc_get bc_invoice_get bc_member_get bc_partner_get bc_transaction_get
          blockedword_check blockedword_list_get blockedword_task_check
          blockedword_task_download campaign_get campaign_quota_info_get catalog_feed_get
          catalog_get catalog_lexicon_get catalog_overview_get catalog_product_get
          catalog_video_get changelog_get changelog_task_check changelog_task_download
          creative_cta_recommend_get creative_portfolio_get creative_portfolio_list_get
          creative_report_get crm_list_get custom_conversion_get custom_conversion_list_get
          diagnostic_catalog_get file_music_get file_name_check gmv_max_report_get identity_get
          identity_info_get identity_live_get identity_video_get identity_video_info_get
          lead_field_get lead_get minis_get offline_get optimizer_rule_get
          optimizer_rule_list_get page_field_get page_get page_library_get pangle_block_list_get
          payment_portfolio_get pixel_list_get playable_get playable_validate
          report_ad_benchmark_get report_integrated_get report_task_check report_task_download
          report_video_performance_get rf_contract_query_get rf_inventory_estimate
          search_ad_negative_keyword_get search_region_get showcase_identity_get
          showcase_product_get showcase_region_get spark_ad_recommend_get split_test_end_get
          split_test_result_get store_list_get store_product_get subscription_get
          targeting_search term_check term_get tool_bid_recommend tool_carrier_get
          tool_diagnosis_get tool_hashtag_get tool_hashtag_recommend_search tool_language_get
          tool_region_get tool_search_diagnosis_health_get tool_search_keyword_idea_get
          tool_search_keyword_recommend tool_targeting_info_get tool_targeting_list_get
          tool_targeting_search tool_timezone_get tool_url_validate tool_vbo_status_check
          tt_video_info_get tt_video_list_get tto_oauth2_info_get tto_tcm_report user_info_get
        `,
          destructive: `
          ad_status_update adgroup_status_update bc_advertiser_disable
          bc_advertiser_unionpay_info_submit bc_asset_admin_delete bc_asset_advertiser_unassign
          bc_asset_group_delete bc_asset_unassign bc_member_delete bc_partner_asset_delete
          bc_partner_delete bc_pixel_transfer bc_transfer blockedword_delete
          campaign_gmv_max_session_delete campaign_status_update catalog_capitalize_migrate
          catalog_delete catalog_eventsource_unbind catalog_feed_delete catalog_product_delete
          catalog_set_delete catalog_video_delete comment_delete comment_status_update
          creative_asset_delete creative_portfolio_delete custom_conversion_delete
          dmp_custom_audience_delete dmp_custom_audience_share_cancel dmp_saved_audience_delete
          offline_delete optimizer_rule_update_status_update page_library_transfer
          pixel_event_delete report_task_cancel rf_order_cancel
          search_ad_negative_keyword_delete smart_plus_ad_material_status_update
          smart_plus_ad_status_update smart_plus_adgroup_status_update
          smart_plus_campaign_status_update subscription_unsubscribe_cancel tt_video_unbind
          tto_tcm_anchor_delete
        `,
        }),
      },
    }),
  ]);
