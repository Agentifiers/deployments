import type { ProviderDefinitionInput } from "../../provider-definitions.ts";
import { REVIEWED_AT, vendorMcpOAuthProvider, vendorMcpToolEffects } from "./shared.ts";

/** Vendor-hosted MCP servers (engineering); pins reviewed against live discovery. */
export const ENGINEERING_VENDOR_MCP_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    vendorMcpOAuthProvider({
      key: "github",
      displayName: "GitHub",
      category: "engineering",
      server: {
        url: "https://api.githubcopilot.com/mcp/",
        resource: "https://api.githubcopilot.com/mcp/",
        authorization: {
          kind: "oauth",
          issuer: "https://github.com/login/oauth",
          authorizationEndpoint: "https://github.com/login/oauth/authorize",
          tokenEndpoint: "https://github.com/login/oauth/access_token",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_basic"],
          scopes: [
            "repo",
            "read:org",
            "read:user",
            "user:email",
            "read:packages",
            "write:packages",
            "read:project",
            "project",
            "gist",
            "notifications",
          ],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_file_contents get_me list_commits list_issues list_notifications list_workflows
          search_code search_issues search_repositories
        `,
          destructive: `delete_file merge_pull_request`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "gitlab",
      displayName: "GitLab",
      category: "engineering",
      server: {
        url: "https://gitlab.com/api/v4/mcp",
        resource: "https://gitlab.com/api/v4/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://gitlab.com",
          authorizationEndpoint: "https://gitlab.com/oauth/authorize",
          tokenEndpoint: "https://gitlab.com/oauth/token",
          revocationEndpoint: "https://gitlab.com/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: ["mcp"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `get_mcp_server_version get_pipeline_jobs gitlab_search semantic_code_search`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "sentry",
      displayName: "Sentry",
      category: "observability",
      server: {
        url: "https://mcp.sentry.dev/mcp",
        resource: "https://mcp.sentry.dev/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.sentry.dev",
          authorizationEndpoint: "https://mcp.sentry.dev/oauth/authorize",
          tokenEndpoint: "https://mcp.sentry.dev/oauth/token",
          revocationEndpoint: "https://mcp.sentry.dev/oauth/token",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["org:read", "project:write", "team:write", "event:write", "alerts:write"],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.sentry.io/product/sentry-mcp/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          find_dsns find_organizations find_projects find_releases find_teams get_doc
          get_event_attachment get_trace_details search_docs search_events search_issues whoami
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "pagerduty",
      displayName: "PagerDuty",
      category: "operations",
      server: {
        url: "https://mcp.pagerduty.com/mcp",
        resource: "https://mcp.pagerduty.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.pagerduty.com/",
          authorizationEndpoint: "https://app.pagerduty.com/global/oauth/authorize",
          tokenEndpoint: "https://app.pagerduty.com/global/oauth/token",
          revocationEndpoint: "https://app.pagerduty.com/global/oauth/revoke",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://support.pagerduty.com/main/docs/pagerduty-mcp-server-integration-guide",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_incident get_service get_user_data list_escalation_policies list_incidents
          list_oncalls list_schedules list_services list_teams list_users
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "datadog",
      displayName: "Datadog",
      category: "engineering",
      server: {
        url: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
        resource: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.datadoghq.com/v1/mcp",
          authorizationEndpoint: "https://app.datadoghq.com/oauth2/v1/authorize",
          tokenEndpoint: "https://app.datadoghq.com/api/v2/oauth2/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.datadoghq.com/bits_ai/mcp_server/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_datadog_incident get_datadog_metric get_datadog_trace search_datadog_dashboards
          search_datadog_docs search_datadog_events search_datadog_hosts
          search_datadog_incidents search_datadog_logs search_datadog_metrics
          search_datadog_monitors search_datadog_rum_events search_datadog_services
          search_datadog_spans
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "new_relic",
      displayName: "New Relic",
      category: "observability",
      server: {
        url: "https://mcp.newrelic.com/mcp/",
        resource: "https://mcp.newrelic.com/mcp/",
        authorization: {
          kind: "oauth",
          issuer: "https://oauth2.service.newrelic.com",
          authorizationEndpoint: "https://oauth2.service.newrelic.com/oauth2/auth",
          tokenEndpoint: "https://oauth2.service.newrelic.com/oauth2/token",
          revocationEndpoint: "https://oauth2.service.newrelic.com/oauth2/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["observability:read", "offline", "offline_access"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.newrelic.com/docs/agentic-ai/mcp/overview/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          analyze_golden_metrics get_dashboard get_entity list_alert_conditions
          list_alert_policies list_change_events list_dashboards list_entity_types
          list_recent_issues list_synthetic_monitors search_incident
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "cloudflare",
      displayName: "Cloudflare",
      category: "engineering",
      server: {
        url: "https://bindings.mcp.cloudflare.com/mcp",
        resource: "https://bindings.mcp.cloudflare.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://bindings.mcp.cloudflare.com",
          authorizationEndpoint: "https://bindings.mcp.cloudflare.com/oauth/authorize",
          tokenEndpoint: "https://bindings.mcp.cloudflare.com/token",
          revocationEndpoint: "https://bindings.mcp.cloudflare.com/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          accounts_list d1_databases_list hyperdrive_configs_list kv_namespaces_list
          r2_buckets_list search_cloudflare_documentation workers_get_worker
          workers_get_worker_code workers_list
        `,
          destructive: `d1_database_delete kv_namespace_delete r2_bucket_delete`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "vercel",
      displayName: "Vercel",
      category: "engineering",
      server: {
        url: "https://mcp.vercel.com",
        resource: "https://mcp.vercel.com/",
        authorization: {
          kind: "oauth",
          issuer: "https://vercel.com",
          authorizationEndpoint: "https://vercel.com/oauth/authorize",
          tokenEndpoint: "https://api.vercel.com/login/oauth/token",
          revocationEndpoint: "https://api.vercel.com/login/oauth/token/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: ["openid"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://vercel.com/docs/mcp/vercel-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          check_domain_availability_and_price get_deployment get_deployment_build_logs
          get_project list_deployments list_projects list_teams search_documentation
          web_fetch_vercel_url
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "netlify",
      displayName: "Netlify",
      category: "engineering",
      server: {
        url: "https://netlify-mcp.netlify.app/mcp",
        resource: "https://netlify-mcp.netlify.app/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://netlify-mcp.netlify.app/",
          authorizationEndpoint: "https://netlify-mcp.netlify.app/oauth-server/auth",
          tokenEndpoint: "https://netlify-mcp.netlify.app/oauth-server/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["offline_access", "read", "write", "claudeai"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "supabase",
      displayName: "Supabase",
      category: "engineering",
      server: {
        url: "https://mcp.supabase.com/mcp",
        resource: "https://mcp.supabase.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://api.supabase.com",
          authorizationEndpoint: "https://api.supabase.com/v1/oauth/authorize",
          tokenEndpoint: "https://api.supabase.com/v1/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [
            "organizations:read",
            "projects:read",
            "projects:write",
            "database:write",
            "database:read",
            "analytics:read",
            "secrets:read",
            "edge_functions:read",
            "edge_functions:write",
            "environment:read",
            "environment:write",
            "storage:read",
            "storage:write",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://supabase.com/docs/guides/getting-started/mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_advisors get_cost get_edge_function get_logs get_organization get_project
          get_project_url get_publishable_keys list_branches list_edge_functions list_extensions
          list_migrations list_organizations list_projects list_tables search_docs
        `,
          destructive: `delete_branch pause_project reset_branch`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "neon",
      displayName: "Neon",
      category: "engineering",
      server: {
        url: "https://mcp.neon.tech/mcp",
        resource: "https://mcp.neon.tech/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.neon.tech",
          authorizationEndpoint: "https://mcp.neon.tech/api/authorize",
          tokenEndpoint: "https://mcp.neon.tech/api/token",
          revocationEndpoint: "https://mcp.neon.tech/api/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://neon.com/docs/ai/neon-mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          describe_branch describe_project describe_table_schema explain_sql_statement fetch
          get_connection_string get_database_tables list_projects list_slow_queries search
        `,
          destructive: `delete_branch delete_project`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "postman",
      displayName: "Postman",
      category: "engineering",
      server: {
        url: "https://mcp.postman.com/mcp",
        resource: "https://mcp.postman.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.postman.com",
          authorizationEndpoint: "https://mcp.postman.com/authorize",
          tokenEndpoint: "https://mcp.postman.com/token",
          revocationEndpoint: "https://mcp.postman.com/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://learning.postman.com/docs/developer/postman-api/postman-mcp-server/",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "posthog",
      displayName: "PostHog",
      category: "product",
      server: {
        url: "https://mcp.posthog.com/mcp",
        resource: "https://mcp.posthog.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://oauth.posthog.com",
          authorizationEndpoint: "https://oauth.posthog.com/oauth/authorize/",
          tokenEndpoint: "https://oauth.posthog.com/oauth/token/",
          revocationEndpoint: "https://oauth.posthog.com/oauth/revoke/",
          registrationMethods: [
            "pre_registered",
            "client_id_metadata_document",
            "dynamic_client_registration",
          ],
          tokenEndpointAuthMethods: ["none", "client_secret_post"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://posthog.com/docs/model-context-protocol",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          dashboards-get-all docs-search event-definitions-list experiment-get-all
          feature-flag-get-all insight-get insights-get-all list-errors organizations-get
          projects-get
        `,
          destructive: `delete-feature-flag insight-delete`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "launchdarkly",
      displayName: "LaunchDarkly",
      category: "engineering",
      server: {
        url: "https://mcp.launchdarkly.com/mcp/fm",
        resource: "https://mcp.launchdarkly.com/mcp/fm",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.launchdarkly.com/mcp/fm",
          authorizationEndpoint: "https://app.launchdarkly.com/trust/oauth/authorize",
          tokenEndpoint: "https://app.launchdarkly.com/trust/oauth/token",
          revocationEndpoint: "https://app.launchdarkly.com/trust/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://launchdarkly.com/docs/home/getting-started/mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get-feature-flag get-flag-status-across-environments list-environments
          list-feature-flags
        `,
          destructive: `delete-feature-flag`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "render",
      displayName: "Render",
      category: "engineering",
      server: {
        url: "https://mcp.render.com/mcp",
        resource: "https://mcp.render.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://api.render.com",
          authorizationEndpoint: "https://api.render.com/v1/oauth/authorize",
          tokenEndpoint: "https://api.render.com/v1/oauth/token",
          revocationEndpoint: "https://api.render.com/v1/oauth/token/revoke",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["none"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://render.com/docs/mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          get_metrics get_service list_deploys list_key_value list_logs list_postgres_instances
          list_services list_workspaces query_render_postgres
        `,
        }),
      },
    }),
  ]);
