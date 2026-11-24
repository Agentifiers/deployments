import type { ProviderDefinitionInput } from "../../provider-definitions.ts";
import { REVIEWED_AT, vendorMcpOAuthProvider, vendorMcpToolEffects } from "./shared.ts";

/** Vendor-hosted MCP servers (messaging); pins reviewed against live discovery. */
export const MESSAGING_VENDOR_MCP_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    vendorMcpOAuthProvider({
      key: "klaviyo",
      displayName: "Klaviyo",
      category: "email_sms",
      server: {
        url: "https://mcp.klaviyo.com/mcp",
        resource: "https://mcp.klaviyo.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.klaviyo.com",
          authorizationEndpoint: "https://mcp.klaviyo.com/authorize",
          tokenEndpoint: "https://mcp.klaviyo.com/token",
          revocationEndpoint: "https://mcp.klaviyo.com/token",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.klaviyo.com/en/docs/klaviyo_mcp_server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_account_details get_agent_knowledge
          get_agent_messages_for_customer_agent_conversation get_agent_skill get_agent_skills
          get_agent_tool get_agent_tools get_all_universal_content get_applications
          get_billing_usage get_brand_button get_brand_buttons get_brand_color get_brand_colors
          get_brand_logo get_brand_logos get_brand_social_group get_brand_social_groups
          get_brand_voice get_campaign get_campaign_recipient_estimation
          get_campaign_recipient_estimation_job get_campaign_report get_campaigns
          get_catalog_categories get_catalog_category get_catalog_item get_catalog_items
          get_catalog_variant get_catalog_variants get_coupon get_coupon_code get_coupon_codes
          get_coupons get_custom_metric get_custom_metrics get_customer_agent get_event
          get_events get_flow get_flow_action get_flow_report get_flows
          get_flows_triggered_by_list get_flows_triggered_by_metric
          get_flows_triggered_by_segment get_form get_form_version get_forms get_image
          get_images get_list get_lists get_mapped_metric get_mapped_metrics
          get_messaging_sender_registration_id_for_text_messaging_sender get_metric
          get_metric_property get_metrics get_profile get_profiles get_review get_reviews
          get_segment get_segments get_sending_domain get_sending_domains
          get_skills_for_agent_tool get_tags get_text_messaging_configuration
          get_text_messaging_sender get_text_messaging_sender_registration
          get_text_messaging_senders get_translation get_translations get_universal_content
          get_webhook get_webhook_topic get_webhook_topics get_webhooks list_agent_knowledge
          list_billing_usage list_customer_agent_conversations query_customer_agent_skill_values
          query_customer_agent_values query_form_series query_form_values
          query_metric_aggregates query_segment_series query_segment_values
          report_unsupported_task retrieve_customer_agent_conversation
        `,
          destructive: `
          bulk_delete_catalog_items bulk_delete_catalog_variants bulk_suppress_profiles
          cancel_campaign_send create_template_preview_send_job delete_agent_knowledge
          delete_agent_skill delete_agent_tool delete_brand_button delete_brand_color
          delete_brand_logo delete_brand_social_group delete_campaign delete_catalog_category
          delete_catalog_item delete_catalog_variant delete_coupon delete_coupon_code
          delete_custom_metric delete_email_template delete_flow delete_form delete_list
          delete_push_token delete_segment delete_sending_domain delete_tag delete_tag_group
          delete_translation delete_universal_content delete_webhook merge_profiles
          remove_categories_from_catalog_item remove_items_from_catalog_category
          remove_profiles_from_list remove_tag_from_campaigns remove_tag_from_flows
          remove_tag_from_lists remove_tag_from_segments request_profile_deletion send_campaign
          unsubscribe_profile_from_marketing
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "activecampaign",
      displayName: "ActiveCampaign",
      category: "email_crm",
      server: {
        url: "https://mcp.app-us1.com/http",
        resource: "https://mcp.app-us1.com/http",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.app-us1.com",
          authorizationEndpoint: "https://mcp.app-us1.com/authorize",
          tokenEndpoint: "https://mcp.app-us1.com/oauth/token",
          revocationEndpoint: "https://mcp.app-us1.com/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["org:read", "project:write", "team:write", "event:write"],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.activecampaign.com/page/mcp-available-tools/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_campaign get_campaign_links get_campaign_messages get_contact
          get_contact_automation get_contact_custom_field get_contact_field_value get_deal
          get_deal_pipeline get_list list_automations list_campaigns list_contact_automations
          list_contact_custom_fields list_contact_field_values list_contacts
          list_custom_object_records list_custom_object_schemas list_deal_activities
          list_deal_pipelines list_deals list_groups list_lists list_tags
        `,
          destructive: `add_contact_to_automation remove_contact_from_automation`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "customer_io",
      displayName: "Customer.io",
      category: "email",
      server: {
        url: "https://mcp.customer.io/mcp",
        resource: "https://mcp.customer.io/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.customer.io",
          authorizationEndpoint: "https://mcp.customer.io/oauth2/authorize",
          tokenEndpoint: "https://mcp.customer.io/oauth2/token",
          revocationEndpoint: "https://mcp.customer.io/oauth2/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post"],
          scopes: ["configure", "read", "read:sensitive", "write", "write:live"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.customer.io/ai/mcp/get-started/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `cio_read_api`,
          destructive: `cio_delete_api cio_write_api`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "brevo",
      displayName: "Brevo",
      category: "email_sms",
      server: {
        url: "https://mcp.brevo.com/v1/brevo/mcp",
        resource: "https://mcp.brevo.com/v1/brevo/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.brevo.com/oauth",
          authorizationEndpoint: "https://mcp.brevo.com/oauth/authorize",
          tokenEndpoint: "https://mcp.brevo.com/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["all"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.brevo.com/docs/mcp-protocol",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "braze",
      displayName: "Braze",
      category: "messaging",
      server: {
        url: "https://mcp.braze.com/mcp",
        resource: "https://mcp.braze.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://dashboard.braze.com",
          authorizationEndpoint: "https://dashboard.braze.com/oauth/authorize",
          tokenEndpoint: "https://rest.iad-01.braze.com/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["mcp:tools", "mcp:resources", "mcp:operator"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://www.braze.com/docs/user_guide/brazeai/mcp_server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_campaign_dataseries get_campaign_details get_campaign_list
          get_campaign_live_details get_canvas_data_series get_canvas_data_summary
          get_canvas_details get_canvas_list get_catalog_item get_catalog_items get_catalogs
          get_content_block_info get_content_blocks get_custom_attributes get_dau_data_series
          get_events get_events_data_series get_events_list get_mau_data_series
          get_new_users_data_series get_operator_result get_product_list get_quantity_series
          get_revenue_series get_segment_data_series get_segment_details get_segment_filters
          get_segment_list get_session_data_series get_uninstalls_data_series get_workspaces
          list_integrations
        `,
          destructive: `
          cancel_operator_job delete_campaign_message delete_campaign_message_variation
          delete_catalog delete_catalog_field delete_catalog_items delete_catalog_selection
          launch_campaign replace_catalog_items stop_campaign
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "sequenzy",
      displayName: "Sequenzy",
      category: "email",
      server: {
        url: "https://api.sequenzy.com/v1/mcp",
        resource: "https://api.sequenzy.com/v1/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://www.sequenzy.com",
          authorizationEndpoint: "https://www.sequenzy.com/api/oauth/authorize",
          tokenEndpoint: "https://www.sequenzy.com/api/oauth/token",
          revocationEndpoint: "https://www.sequenzy.com/api/oauth/revoke",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["mcp"],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.sequenzy.com/concepts/mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          check_website get_ab_test get_ab_test_stats get_account get_app_urls get_attio_mapping
          get_campaign get_campaign_audience get_campaign_stats get_company get_conversation
          get_event_schema get_form_embed get_integration get_integration_guide
          get_integration_pixel get_landing_page get_landing_page_stats
          get_notification_preferences get_popup get_popup_embed get_recipient_suppression
          get_segment_count get_sending_status get_sequence get_sequence_enrollment
          get_sequence_enrollment_realignment get_sequence_inbound_webhook get_sequence_stats
          get_shopify_automation_settings get_stats get_subscriber get_subscriber_activity
          get_template get_tracking_settings get_transactional_stats get_web_tracking_key
          list_ab_tests list_ad_accounts list_api_keys list_audience_syncs list_campaign_events
          list_campaign_goals list_campaigns list_conversations list_forms
          list_integration_activity list_integration_capabilities list_integrations
          list_landing_pages list_lists list_poll_responses list_popups list_products
          list_recipient_suppressions list_segments list_sender_profiles
          list_sequence_enrollments list_sequence_events list_sequence_goals list_sequences
          list_subscriber_notes list_tags list_team_members list_templates
          list_transactional_emails list_web_tracking_keys list_webhook_deliveries list_webhooks
          list_websites search_subscribers
        `,
          destructive: `
          archive_sequence bulk_remove_subscriber_tags cancel_campaign
          cancel_sequence_enrollments cancel_team_invitation delete_ab_test
          delete_ab_test_variant delete_api_key delete_audience_sync delete_campaign
          delete_campaign_goal delete_email_component delete_landing_page delete_list
          delete_popup delete_product delete_segment delete_sender_profile delete_sequence
          delete_sequence_goal delete_subscriber_note delete_tag delete_template
          delete_transactional_email delete_web_tracking_key delete_webhook disable_sequence
          edit_sequence_graph move_sequence_enrollments realign_sequence_enrollments
          release_sms_number remove_landing_page_domain remove_product_file
          remove_recipient_suppression remove_subscriber remove_subscribers_from_list
          restart_ab_test revoke_api_key rotate_sequence_inbound_webhook_secret
          set_integration_list_targeting set_integration_sync_enabled unpublish_landing_page
          unshare_campaign unshare_template
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "nitrosend",
      displayName: "NitroSend",
      category: "email",
      server: {
        url: "https://api.nitrosend.com/mcp",
        resource: "https://api.nitrosend.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://api.nitrosend.com",
          authorizationEndpoint: "https://api.nitrosend.com/oauth/authorize",
          tokenEndpoint: "https://api.nitrosend.com/oauth/token",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["mcp"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://nitrosend.com/mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          nitro_get_insights nitro_get_status nitro_query nitro_search_contacts
          nitro_search_docs
        `,
          destructive: `
          nitro_control_delivery nitro_manage_audience nitro_manage_domains nitro_send_message
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "resend",
      displayName: "Resend",
      category: "email",
      server: {
        url: "https://mcp.resend.com/mcp",
        resource: "https://mcp.resend.com",
        authorization: {
          kind: "oauth",
          issuer: "https://api.resend.com",
          authorizationEndpoint: "https://api.resend.com/oauth/authorize",
          tokenEndpoint: "https://api.resend.com/oauth/token",
          revocationEndpoint: "https://api.resend.com/oauth/revoke",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://resend.com/docs/mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get-automation get-automation-runs get-broadcast get-contact get-contact-property
          get-domain get-domain-claim get-segment get-suppression get-template
          get-tiptap-json-content get-topic get-usage get-webhook get-webhook-event
          list-api-keys list-broadcast-clicked-links list-broadcast-recipients list-broadcasts
          list-contact-imports list-contact-properties list-contact-segments list-contact-topics
          list-contacts list-domains list-emails list-logs list-oauth-grants
          list-received-emails list-segments list-suppressions list-templates list-topics
          list-webhook-event-attempts list-webhook-events list-webhooks
        `,
          destructive: `
          batch-remove-suppressions cancel-broadcast cancel-email manage-events remove-api-key
          remove-automation remove-broadcast remove-contact remove-contact-from-segment
          remove-contact-property remove-domain remove-segment remove-suppression
          remove-template remove-topic remove-webhook replay-webhook-event revoke-oauth-grant
          rotate-webhook-signing-secret send-batch-emails send-broadcast send-email send-event
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "onesignal",
      displayName: "OneSignal",
      category: "push",
      server: {
        url: "https://api.onesignal.com/mcp/oauth",
        resource: "https://api.onesignal.com",
        authorization: {
          kind: "oauth",
          issuer: "https://api.onesignal.com",
          authorizationEndpoint: "https://dashboard.onesignal.com/oauth/authorize",
          tokenEndpoint: "https://api.onesignal.com/oauth/token",
          revocationEndpoint: "https://api.onesignal.com/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://documentation.onesignal.com/docs/en/model-context-protocol",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          estimate_recipient_count export_audience_activity_csv export_subscriptions_csv
          get_active_warm_up_schedules get_custom_events get_provider_metrics
          get_provider_metrics_timeseries get_segment get_template get_user_identity
          get_user_identity_by_subscription list_apps list_messages list_segments list_templates
          onesignal_reference_overview view_outcomes view_user
        `,
          destructive: `send_message start_live_activity unsubscribe_email update_live_activity`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "attentive",
      displayName: "Attentive",
      category: "sms",
      server: {
        url: "https://attentive-ui-mcp.attentivemobile.com/mcp",
        resource: "https://attentive-ui-mcp.attentivemobile.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp-auth.attentivemobile.com",
          authorizationEndpoint: "https://mcp-auth.attentivemobile.com/oauth2/authorize",
          tokenEndpoint: "https://mcp-auth.attentivemobile.com/oauth2/token",
          revocationEndpoint: "https://mcp-auth.attentivemobile.com/oauth2/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["mcp"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.attentive.com/docs/mcp-installation",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_brand_voice_settings get_campaign get_campaign_metrics get_creative get_journey
          get_journey_branch get_journey_configuration get_journey_graph get_revision_settings
          get_segment get_segment_counts get_user list_brand_assets list_campaigns
          list_creatives list_journey_templates list_journey_triggers list_journeys list_metrics
          list_product_attribute_values list_segment_subscribers list_segments
          list_user_attributes list_user_companies query_metrics
        `,
          destructive: `
          delete_campaign delete_campaign_message delete_campaign_message_group delete_journey
          delete_journey_node delete_segment publish_journey schedule_campaign_send
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "kit",
      displayName: "Kit",
      category: "newsletter",
      server: {
        url: "https://app.kit.com/mcp",
        resource: "https://app.kit.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://api.kit.com",
          authorizationEndpoint: "https://app.kit.com/oauth/authorize",
          tokenEndpoint: "https://app.kit.com/oauth/token",
          revocationEndpoint: "https://api.kit.com/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://help.kit.com/en/articles/14827557-how-to-connect-the-kit-mcp-to-your-ai-tools",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_broadcast get_creator_profile get_current_account get_growth_stats get_purchase
          get_sequence get_snippet get_stats_for_a_broadcast get_stats_for_a_list_of_broadcasts
          get_subscriber list_broadcasts list_colors list_custom_fields list_domains list_forms
          list_posts list_products list_prompt_suggestions list_purchases list_segments
          list_sequence_emails list_sequences list_snippets list_stats_for_a_subscriber
          list_subscribers list_subscribers_for_form list_subscribers_for_sequence list_tags
          list_tags_for_a_subscriber list_tax_codes list_webhooks
        `,
          destructive: `
          bulk_delete_tags bulk_remove_tags_from_subscribers delete_broadcast
          delete_custom_field delete_sequence delete_sequence_email delete_webhook
          remove_tag_from_subscriber unsubscribe
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "beehiiv",
      displayName: "beehiiv",
      category: "newsletter",
      server: {
        url: "https://mcp.beehiiv.com/mcp",
        resource: "https://mcp.beehiiv.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.beehiiv.com",
          authorizationEndpoint: "https://mcp.beehiiv.com/authorize",
          tokenEndpoint: "https://mcp.beehiiv.com/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["read", "write"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://www.beehiiv.com/support/article/39255979546263-getting-started-with-the-beehiiv-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_publication get_publication_stats get_subscription get_workspace list_posts
          list_publications list_subscriptions
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "buffer",
      displayName: "Buffer",
      category: "marketing",
      server: {
        url: "https://mcp.buffer.com/mcp",
        resource: "https://mcp.buffer.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://auth.buffer.com",
          authorizationEndpoint: "https://auth.buffer.com/auth",
          tokenEndpoint: "https://auth.buffer.com/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: [
            "posts:read",
            "posts:write",
            "ideas:read",
            "ideas:write",
            "account:read",
            "account:write",
            "insights:read",
            "engagements:read",
            "engagements:write",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.buffer.com/guides/integrations/mcp.md",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `get_account get_channel list_channels list_idea_groups list_ideas list_posts`,
          destructive: `create_post delete_post delete_post_template execute_mutation`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "sprout_social",
      displayName: "Sprout Social",
      category: "messaging",
      server: {
        url: "https://mcp.sproutsocial.com/mcp",
        resource: "https://mcp.sproutsocial.com",
        authorization: {
          kind: "oauth",
          issuer: "https://identity.sproutsocial.com/oauth2/84e39c75-d770-45d9-90a9-7b79e3037d2c",
          authorizationEndpoint:
            "https://identity.sproutsocial.com/oauth2/84e39c75-d770-45d9-90a9-7b79e3037d2c/v1/authorize",
          tokenEndpoint:
            "https://identity.sproutsocial.com/oauth2/84e39c75-d770-45d9-90a9-7b79e3037d2c/v1/token",
          revocationEndpoint:
            "https://identity.sproutsocial.com/oauth2/84e39c75-d770-45d9-90a9-7b79e3037d2c/v1/revoke",
          authorizationServerMetadataUrl:
            "https://mcp.sproutsocial.com/.well-known/oauth-authorization-server",
          protectedResourceAuthorizationServer: "https://mcp.sproutsocial.com",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: ["openid", "profile", "organization_id"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://support.sproutsocial.com/hc/en-us/articles/41236268336653-ChatGPT-Connection-Overview-and-Setup",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
  ]);
