import type { ProviderDefinitionInput } from "../../provider-definitions.ts";
import { REVIEWED_AT, vendorMcpOAuthProvider, vendorMcpToolEffects } from "./shared.ts";

/** Vendor-hosted MCP servers (communication); pins reviewed against live discovery. */
export const COMMUNICATION_VENDOR_MCP_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    vendorMcpOAuthProvider({
      key: "slack",
      displayName: "Slack",
      category: "communication",
      server: {
        url: "https://mcp.slack.com/mcp",
        resource: "https://mcp.slack.com",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.slack.com",
          authorizationEndpoint: "https://slack.com/oauth/v2_user/authorize",
          tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_post"],
          scopes: [
            "canvases:read",
            "canvases:write",
            "channels:history",
            "channels:read",
            "channels:write",
            "chat:write",
            "emoji:read",
            "files:read",
            "files:write",
            "groups:history",
            "groups:read",
            "groups:write",
            "im:history",
            "im:read",
            "im:write",
            "lists:read",
            "lists:write",
            "mpim:history",
            "mpim:read",
            "mpim:write",
            "reactions:read",
            "reactions:write",
            "search:read.files",
            "search:read.im",
            "search:read.mpim",
            "search:read.private",
            "search:read.public",
            "search:read.users",
            "users:read",
            "users:read.email",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          slack_get_reactions slack_list_channel_members slack_read_canvas slack_read_channel
          slack_read_file slack_read_thread slack_read_user_profile slack_search_channels
          slack_search_public slack_search_public_and_private slack_search_users
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "zoom",
      displayName: "Zoom",
      category: "communication",
      server: {
        url: "https://mcp.zoom.us/mcp/zoom/streamable",
        resource: "https://mcp.zoom.us/mcp/zoom/streamable",
        authorization: {
          kind: "oauth",
          issuer: "https://zoom.us",
          authorizationEndpoint: "https://zoom.us/oauth/authorize",
          tokenEndpoint: "https://zoom.us/oauth/token",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_basic"],
          scopes: [
            "agentic_search:read:search",
            "meeting:write:meeting",
            "meeting:read:search",
            "docs:update:collaborator",
            "docs:read:export",
            "docs:write:import",
            "agentic_search:read:ask",
            "hub:write:content",
            "meeting:update:in_meeting_controls",
            "cloud_recording:read:content",
            "meeting:update:meeting",
            "meeting:delete:meeting",
            "docs:read:list_file_collaborators",
            "cloud_recording:read:list_user_recordings",
            "meeting:read:assets",
            "docs:write:collaborator",
            "my_notes:read:content",
            "docs:delete:collaborator",
            "hub:read:content",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.zoom.us/docs/mcp/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_file_content get_meeting_assets get_recording_resource hub_get_file_content
          recordings_list search search_meetings
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "webex_meetings",
      displayName: "Webex Meetings",
      category: "communication",
      server: {
        url: "https://mcp.webexapis.com/mcp/webex-meeting",
        resource: "https://mcp.webexapis.com/mcp/webex-meeting",
        authorization: {
          kind: "oauth",
          issuer: "https://webexapis.com",
          authorizationEndpoint: "https://webexapis.com/v1/authorize",
          tokenEndpoint: "https://webexapis.com/v1/access_token",
          authorizationServerMetadataUrl:
            "https://mcp.webexapis.com/.well-known/oauth-authorization-server/mcp/webex-meeting",
          protectedResourceAuthorizationServer: "https://mcp.webexapis.com/mcp/webex-meeting",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_basic"],
          scopes: [
            "spark:mcp",
            "meeting:schedules_read",
            "meeting:schedules_write",
            "meeting:participants_read",
            "meeting:summaries_read",
            "meeting:recordings_read",
            "meeting:transcripts_read",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.webex.com/mcp/docs/meetings-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          webex-get-meeting-status webex-get-meeting-summary webex-list-meetings
          webex-list-recordings webex-list-transcripts
        `,
          destructive: `webex-delete-meeting`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "webex_messaging",
      displayName: "Webex Messaging",
      category: "communication",
      server: {
        url: "https://mcp.webexapis.com/mcp/webex-messaging",
        resource: "https://mcp.webexapis.com/mcp/webex-messaging",
        authorization: {
          kind: "oauth",
          issuer: "https://webexapis.com",
          authorizationEndpoint: "https://webexapis.com/v1/authorize",
          tokenEndpoint: "https://webexapis.com/v1/access_token",
          authorizationServerMetadataUrl:
            "https://mcp.webexapis.com/.well-known/oauth-authorization-server/mcp/webex-messaging",
          protectedResourceAuthorizationServer: "https://mcp.webexapis.com/mcp/webex-messaging",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_basic"],
          scopes: [
            "spark:mcp",
            "spark:messages_write",
            "spark:messages_read",
            "spark:rooms_write",
            "spark:rooms_read",
            "spark:memberships_write",
            "spark:memberships_read",
            "spark:webhooks_write",
            "spark:webhooks_read",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.webex.com/mcp/docs/messaging-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          webex-download-file webex-get-file-details webex-get-membership webex-get-space
          webex-get-thread webex-get-webhook webex-search-messages webex-search-spaces
        `,
          destructive: `
          webex-delete-message webex-delete-space webex-delete-webhook webex-remove-membership
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "gmail",
      displayName: "Gmail",
      category: "communication",
      server: {
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        resource: "https://gmailmcp.googleapis.com/mcp/v1",
        authorization: {
          kind: "oauth",
          issuer: "https://accounts.google.com",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          revocationEndpoint: "https://oauth2.googleapis.com/revoke",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [
            "https://mail.google.com/",
            "https://www.googleapis.com/auth/gmail.compose",
            "https://www.googleapis.com/auth/gmail.drafts",
            "https://www.googleapis.com/auth/gmail.drafts.create",
            "https://www.googleapis.com/auth/gmail.drafts.readonly",
            "https://www.googleapis.com/auth/gmail.labels",
            "https://www.googleapis.com/auth/gmail.metadata",
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.settings.basic",
          ],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `get_thread list_drafts list_labels search_threads`,
          destructive: `
          apply_sensitive_message_label apply_sensitive_thread_label mark_message_spam
          mark_thread_spam trash_message trash_thread unlabel_message unlabel_thread
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "google_calendar",
      displayName: "Google Calendar",
      category: "communication",
      server: {
        url: "https://calendarmcp.googleapis.com/mcp/v1",
        resource: "https://calendarmcp.googleapis.com/mcp/v1",
        authorization: {
          kind: "oauth",
          issuer: "https://accounts.google.com",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          revocationEndpoint: "https://oauth2.googleapis.com/revoke",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/calendar.acls",
            "https://www.googleapis.com/auth/calendar.calendarlist",
            "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
            "https://www.googleapis.com/auth/calendar.calendars",
            "https://www.googleapis.com/auth/calendar.calendars.readonly",
            "https://www.googleapis.com/auth/calendar.events",
            "https://www.googleapis.com/auth/calendar.events.freebusy",
            "https://www.googleapis.com/auth/calendar.events.readonly",
            "https://www.googleapis.com/auth/calendar.freebusy",
            "https://www.googleapis.com/auth/calendar.readonly",
            "https://www.googleapis.com/auth/calendar.settings.readonly",
          ],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `get_event list_calendars list_events search_events suggest_time`,
          destructive: `delete_event`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "calendly",
      displayName: "Calendly",
      category: "scheduling",
      server: {
        url: "https://mcp.calendly.com",
        resource: "https://mcp.calendly.com/",
        authorization: {
          kind: "oauth",
          issuer: "https://calendly.com/",
          authorizationEndpoint: "https://calendly.com/oauth/authorize",
          tokenEndpoint: "https://calendly.com/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["mcp:scheduling:write", "mcp:scheduling:read"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.calendly.com/docs/mcp/calendly-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          availability-list_user_availability_schedules availability-list_user_busy_times
          event_types-get_event_type event_types-list_event_type_available_times
          event_types-list_event_types list_calendly_skills
          locations-list_user_meeting_locations meetings-get_event meetings-get_event_invitee
          meetings-get_invitee_no_show meetings-list_event_invitees meetings-list_events
          organizations-get_organization organizations-get_organization_membership
          organizations-list_organization_invitations
          organizations-list_organization_memberships routing_forms-get_routing_form
          routing_forms-get_routing_form_submission routing_forms-list_routing_form_submissions
          routing_forms-list_routing_forms users-get_current_user users-get_user
        `,
          destructive: `meetings-cancel_event organizations-revoke_organization_invitation`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "granola",
      displayName: "Granola",
      category: "communication",
      server: {
        url: "https://mcp.granola.ai/mcp",
        resource: "https://mcp.granola.ai/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp-auth.granola.ai",
          authorizationEndpoint: "https://mcp-auth.granola.ai/oauth2/authorize",
          tokenEndpoint: "https://mcp-auth.granola.ai/oauth2/token",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["mcp"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.granola.ai/help-center/sharing/integrations/mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_account_info get_meeting_transcript get_meetings list_meeting_folders
          list_meetings query_granola_meetings
        `,
        }),
      },
    }),
  ]);
