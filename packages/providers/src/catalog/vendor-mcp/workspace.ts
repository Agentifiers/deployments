import type { ProviderDefinitionInput } from "../../provider-definitions.ts";
import { REVIEWED_AT, vendorMcpOAuthProvider, vendorMcpToolEffects } from "./shared.ts";

/** Vendor-hosted MCP servers (workspace); pins reviewed against live discovery. */
export const WORKSPACE_VENDOR_MCP_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    vendorMcpOAuthProvider({
      key: "notion",
      displayName: "Notion",
      category: "work-management",
      server: {
        url: "https://mcp.notion.com/mcp",
        resource: "https://mcp.notion.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.notion.com",
          authorizationEndpoint: "https://mcp.notion.com/authorize",
          tokenEndpoint: "https://mcp.notion.com/token",
          revocationEndpoint: "https://mcp.notion.com/token",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["default"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.notion.com/guides/mcp/mcp-supported-tools",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          notion-ai-search notion-download-attachment notion-download-skill notion-fetch
          notion-get-async-task notion-get-comments notion-get-session-status notion-get-teams
          notion-get-tool-access notion-get-users notion-list-agents notion-list-session-events
          notion-query-data-sources notion-query-meeting-notes notion-query-sessions
          notion-read-session-event notion-search notion-search-agents notion-search-sessions
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "atlassian",
      displayName: "Atlassian",
      category: "work-management",
      aliases: ["jira", "confluence"],
      server: {
        url: "https://mcp.atlassian.com/v2/mcp",
        resource: "https://mcp.atlassian.com/v2/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3",
          authorizationEndpoint: "https://auth.atlassian.com/authorize",
          tokenEndpoint: "https://auth.atlassian.com/oauth/token",
          revocationEndpoint: "https://auth.atlassian.com/oauth/revoke",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [
            "read:me",
            "read:account",
            "offline_access",
            "email",
            "read:jira:agent-interface",
            "write:jira:agent-interface",
            "search:jira:agent-interface",
            "delete:jira:agent-interface",
            "manage:jira:agent-interface",
            "read:confluence:agent-interface",
            "write:confluence:agent-interface",
            "search:confluence:agent-interface",
            "search:rovo:agent-interface",
            "search:code:agent-interface",
            "read:all:twg",
            "write:all:twg",
            "read:goals:agent-interface",
            "write:goals:agent-interface",
            "read:projects:agent-interface",
            "write:projects:agent-interface",
            "read:bitbucket:agent-interface",
            "write:bitbucket:agent-interface",
            "read:loom:agent-interface",
            "write:loom:agent-interface",
            "read:talent:agent-interface",
            "write:talent:agent-interface",
            "read:jira-align:agent-interface",
            "write:jira-align:agent-interface",
            "read:teams:agent-interface",
            "write:teams:agent-interface",
            "read:artifacts:agent-interface",
            "write:artifacts:agent-interface",
            "read:capacity-planning:agent-interface",
            "write:capacity-planning:agent-interface",
            "read:focus:agent-interface",
            "write:focus:agent-interface",
            "read:assets:agent-interface",
            "write:assets:agent-interface",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://support.atlassian.com/atlassian-ai-gateway/docs/supported-tools/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          atlassianUserInfo diffCodeSymbols diffConfluenceContentVersions discover
          downloadConfluenceAttachment exportConfluenceContent getAccessibleAtlassianResources
          getBitbucketRepoBranch getBitbucketRepoDefaultReviewers getBitbucketRepoDeployment
          getBitbucketRepoEnvironment getBitbucketRepoFileContent getBitbucketRepoPipeline
          getBitbucketRepoPipelineStep getBitbucketRepository getBitbucketWorkspace
          getCapacityPlanAllocations getCodeFile getCodeSymbol getConfluenceAttachment
          getConfluenceContent getConfluenceContentPermissions
          getConfluenceContentRestrictionState getConfluenceContentVersion getConfluenceMauiApp
          getConfluencePersonalSpace getConfluenceReactions getConfluenceSpace
          getConfluenceSpaceInstructions getConfluenceTask getConfluenceTemplate
          getContentFormatGuide getFocusArea getFocusAreaTypes getGoal getGoalTypes
          getJiraBoardConfig getJiraBoardSprintData getJiraCurrentUser getJiraEntityProperty
          getJiraProjectVersionRelatedWork getJiraProjectVersions getJiraScreen getJiraUser
          getJiraWorkflows getJsmOpsAlerts getJsmOpsTeamInfo getLoomMeetingActionItems
          getLoomVideo getLoomVideoComments getLoomVideoDownloadUrl getProject getTalentFields
          getTalentGroupMetrics getTalentPosition getTalentPositionsByEntity getTalentUser
          getTeam getTeamworkGraphContext getTeamworkGraphObject listBitbucketRepoDeployments
          listBitbucketRepoEnvironments listBitbucketRepoPipelineSteps
          listBitbucketRepoPipelines listBitbucketRepositories listBitbucketWorkspaces
          listCodeDirectory listConfluenceAttachments listConfluenceComments
          listConfluenceContent listConfluenceContentVersions listConfluenceSpaces
          listConfluenceTasks listConfluenceTemplates listJiraBoardSprints listJiraBoards
          listJiraDashboards listJiraFilters listJiraProjectComponents listJiraProjects
          listJiraStatuses listLoomFolders listLoomVideos listLoomVideosSharedWithMe
          lookupJiraAccountId resolveConfluenceContentMacros search
          searchCapacityPlanNonProjectWork searchCode searchConfluence searchFocusAreas
          searchGoals searchJiraIssuesUsingJql searchProjects searchTalentPositions searchTeams
        `,
          destructive: `
          deleteJiraComment deleteJiraIssue deleteJiraIssueAttachment executeDestructive
          mergeBitbucketRepoPullRequest removeConfluenceContentPermissions
          replaceConfluenceContentPermissions
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "trello",
      displayName: "Trello",
      category: "work-management",
      server: {
        url: "https://mcp.trello.com/v1",
        resource: "https://mcp.trello.com/v1",
        authorization: {
          kind: "oauth",
          issuer: "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3",
          authorizationEndpoint: "https://auth.atlassian.com/authorize",
          tokenEndpoint: "https://auth.atlassian.com/oauth/token",
          revocationEndpoint: "https://auth.atlassian.com/oauth/revoke",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [
            "offline_access",
            "read:me",
            "read:account",
            "read:board:trello",
            "write:board:trello",
            "read:organization:trello",
            "write:organization:trello",
            "read:member:trello",
            "read:member.inbox:trello",
            "write:member.inbox:trello",
            "read:member.planner:trello",
            "write:member.planner:trello",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://support.atlassian.com/trello/docs/connect-trello-to-ai-assistants-with-trello-mcp/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          trelloReadBoard trelloReadCard trelloReadChecklist trelloReadInbox trelloReadList
          trelloReadMember trelloReadPlanner trelloSearch
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "dropbox",
      displayName: "Dropbox",
      category: "work-management",
      server: {
        url: "https://mcp.dropbox.com/mcp",
        resource: "https://mcp.dropbox.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://www.dropbox.com",
          authorizationEndpoint: "https://www.dropbox.com/oauth2/authorize",
          tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
          revocationEndpoint: "https://api.dropboxapi.com/2/auth/token/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [
            "account_info.read",
            "file_requests.read",
            "file_requests.write",
            "files.content.read",
            "files.content.write",
            "files.metadata.read",
            "files.metadata.write",
            "sharing.read",
            "sharing.write",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          CheckJobStatus GetFileContent GetFileMetadata GetFileRequest GetMarkdown GetTranscript
          GetUsageAndQuota ListFileRequests ListFileRevisions ListFolder ListSharedLinks Search
        `,
          destructive: `Delete RestoreFileRevision RestoreFolder`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "box",
      displayName: "Box",
      category: "work-management",
      server: {
        url: "https://mcp.box.com",
        resource: "https://mcp.box.com/",
        authorization: {
          kind: "oauth",
          issuer: "https://api.box.com",
          authorizationEndpoint: "https://account.box.com/api/oauth2/authorize",
          tokenEndpoint: "https://api.box.com/oauth2/token",
          revocationEndpoint: "https://api.box.com/oauth2/revoke",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.box.com/guides/box-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_docgen_template_by_id get_download_url get_file_content get_file_details
          get_file_preview get_folder_details get_hub_details get_hub_items
          get_metadata_template_schema list_docgen_templates list_file_comments
          list_folder_content_by_folder_id list_hubs list_item_collaborations
          list_metadata_templates list_tasks search_files_keyword search_files_metadata
          search_folders_by_name
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "miro",
      displayName: "Miro",
      category: "work-management",
      server: {
        url: "https://mcp.miro.com/",
        resource: "https://mcp.miro.com/",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.miro.com/",
          authorizationEndpoint: "https://mcp.miro.com/authorize",
          tokenEndpoint: "https://mcp.miro.com/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: ["boards:read", "boards:write", "openid", "email"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.miro.com/docs/miro-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          board_search_boards canvas_get_canvas_composer_skill canvas_read_as_svg canvas_search
          image_get_data image_get_url prototype_read table_list_rows
        `,
          destructive: `canvas_update_from_svg`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "canva",
      displayName: "Canva",
      category: "work-management",
      server: {
        url: "https://mcp.canva.com/mcp",
        resource: "https://mcp.canva.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.canva.com",
          authorizationEndpoint: "https://mcp.canva.com/authorize",
          tokenEndpoint: "https://mcp.canva.com/token",
          revocationEndpoint: "https://mcp.canva.com/token",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [
            "profile:read",
            "design:meta:read",
            "design:content:write",
            "design:content:read",
            "folder:read",
            "folder:write",
            "brandtemplate:content:read",
            "brandtemplate:meta:read",
            "brandtemplate:content:write",
            "comment:write",
            "comment:read",
            "asset:read",
            "asset:write",
            "brandkit:read",
            "help:answers:read",
            "help:answers:write",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://www.canva.dev/docs/apps/mcp/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get-assets get-brand-template-dataset get-design get-design-content get-design-pages
          get-design-thumbnail get-export-formats get-presenter-notes list-brand-kits
          list-comments list-folder-items list-replies resolve-shortlink search-brand-templates
          search-designs search-folders
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "figma",
      displayName: "Figma",
      category: "data",
      server: {
        url: "https://mcp.figma.com/mcp",
        resource: "https://mcp.figma.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://api.figma.com",
          authorizationEndpoint: "https://www.figma.com/oauth/mcp",
          tokenEndpoint: "https://api.figma.com/v1/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: ["mcp:connect"],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.figma.com/docs/figma-mcp-server/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          download_assets get_code_connect_map get_code_connect_suggestions
          get_context_for_code_connect get_design_context get_figjam get_generative_plugin
          get_libraries get_metadata get_motion_context get_screenshot get_shader
          get_variable_defs list_file_shaders list_generative_plugins list_shaders
          search_design_system weave_get_tool_inputs weave_list_tools whoami
        `,
          destructive: `use_figma`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "airtable",
      displayName: "Airtable",
      category: "data",
      server: {
        url: "https://mcp.airtable.com/mcp",
        resource: "https://mcp.airtable.com",
        authorization: {
          kind: "oauth",
          issuer: "https://airtable.com/oauth2/v1",
          authorizationEndpoint: "https://airtable.com/oauth2/v1/authorize",
          tokenEndpoint: "https://airtable.com/oauth2/v1/token",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_basic"],
          scopes: [
            "data.records:read",
            "data.records:write",
            "schema.bases:read",
            "schema.bases:write",
            "data.recordComments:read",
            "data.recordComments:write",
            "workspacesAndBases:read",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://airtable.com/developers/agents/mcp/getting-started",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          fetch_automation_input_data get_automation get_form_schema get_table_schema
          list_automations list_bases list_external_accounts list_pages_for_base
          list_records_for_page list_records_for_table list_tables_for_base list_views_for_table
          list_workspaces search_bases search_candidate_linked_records search_records
        `,
          destructive: `
          delete_automation delete_interface delete_page delete_records_for_table delete_table
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "coda",
      displayName: "Coda",
      category: "work-management",
      server: {
        url: "https://coda.io/apis/mcp",
        resource: "https://coda.io/apis/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://coda.io",
          authorizationEndpoint: "https://coda.io/v4/api/oauth2/authorize",
          tokenEndpoint: "https://coda.io/v4/api/oauth2/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post"],
          scopes: ["mcp:all"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://help.coda.io/hc/en-us/articles/44722661982989-Connect-to-the-Coda-MCP",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          content_read control_read page_describe search table_columns_read table_rows_read
          whoami
        `,
          destructive: `
          comment_delete control_delete document_delete page_delete table_columns_delete
          table_delete table_rows_delete table_view_delete
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "google_drive",
      displayName: "Google Drive",
      category: "data",
      server: {
        url: "https://drivemcp.googleapis.com/mcp/v1",
        resource: "https://drivemcp.googleapis.com/mcp/v1",
        authorization: {
          kind: "oauth",
          issuer: "https://accounts.google.com",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          revocationEndpoint: "https://oauth2.googleapis.com/revoke",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/drive.file",
          ],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://developers.google.com/workspace/drive/api/guides/configure-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          download_file_content get_file_metadata get_file_permissions list_recent_files
          read_file_content search_files
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "asana",
      displayName: "Asana",
      category: "work-management",
      server: {
        url: "https://mcp.asana.com/v2/mcp",
        resource: "https://mcp.asana.com/v2/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://app.asana.com",
          authorizationEndpoint: "https://app.asana.com/-/oauth_authorize",
          tokenEndpoint: "https://app.asana.com/-/oauth_token",
          revocationEndpoint: "https://app.asana.com/-/oauth_revoke",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: ["default"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.asana.com/docs/using-asanas-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_me get_portfolio get_portfolios get_project get_projects get_status_overview
          get_task get_tasks get_teams get_user get_users search_objects search_tasks
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "monday",
      displayName: "Monday.com",
      category: "work-management",
      server: {
        url: "https://mcp.monday.com/mcp",
        resource: "https://mcp.monday.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://auth.monday.com/mcp",
          authorizationEndpoint: "https://auth.monday.com/oauth2/authorize",
          tokenEndpoint: "https://auth.monday.com/oauth_ms/oauth/token",
          revocationEndpoint: "https://auth.monday.com/oauth_ms/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.monday.com/apps/docs/mondaycom-mcp-integration",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `get_board_info get_board_items_page get_graphql_schema list_users_and_teams search`,
          destructive: `delete_item`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "clickup",
      displayName: "ClickUp",
      category: "work-management",
      server: {
        url: "https://mcp.clickup.com/mcp",
        resource: "https://mcp.clickup.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.clickup.com",
          authorizationEndpoint: "https://mcp.clickup.com/oauth/authorize",
          tokenEndpoint: "https://mcp.clickup.com/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["read", "write"],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          clickup_get_document_pages clickup_get_task clickup_get_task_comments
          clickup_get_time_entries clickup_get_workspace_hierarchy clickup_search
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "linear",
      displayName: "Linear",
      category: "work-management",
      server: {
        url: "https://mcp.linear.app/mcp",
        resource: "https://mcp.linear.app/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.linear.app",
          authorizationEndpoint: "https://mcp.linear.app/authorize",
          tokenEndpoint: "https://mcp.linear.app/token",
          revocationEndpoint: "https://mcp.linear.app/token",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["read", "write"],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://linear.app/docs/mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_document get_project get_team get_user list_comments list_cycles list_documents
          list_issues list_projects list_teams list_users search_documentation
        `,
        }),
      },
    }),
  ]);
