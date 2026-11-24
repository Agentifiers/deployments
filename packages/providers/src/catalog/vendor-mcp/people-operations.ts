import type { ProviderDefinitionInput } from "../../provider-definitions.ts";
import { REVIEWED_AT, vendorMcpOAuthProvider, vendorMcpToolEffects } from "./shared.ts";

/** Vendor-hosted MCP servers (people); pins reviewed against live discovery. */
export const PEOPLE_VENDOR_MCP_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    vendorMcpOAuthProvider({
      key: "greenhouse",
      displayName: "Greenhouse",
      category: "business",
      server: {
        url: "https://mcp.greenhouse.io/mcp",
        resource: "https://mcp.greenhouse.io/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://auth.greenhouse.io",
          authorizationEndpoint: "https://auth.greenhouse.io/authorize",
          tokenEndpoint: "https://auth.greenhouse.io/token",
          revocationEndpoint: "https://auth.greenhouse.io/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["greenhouse:mcp_client"],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl:
          "https://support.greenhouse.io/hc/en-us/articles/52090956642075-Greenhouse-MCP",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "gusto",
      displayName: "Gusto",
      category: "people-operations",
      server: {
        url: "https://mcp.api.gusto.com",
        resource: "https://mcp.api.gusto.com/",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.api.gusto.com",
          authorizationEndpoint: "https://mcp.api.gusto.com/oauth/authorize",
          tokenEndpoint: "https://mcp.api.gusto.com/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://gusto.com/product/integrations/gusto-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "ashby",
      displayName: "Ashby",
      category: "people-operations",
      server: {
        url: "https://mcp.ashbyhq.com/mcp/v1",
        resource: "https://mcp.ashbyhq.com/mcp/v1",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp-auth.ashbyhq.com/oidc",
          authorizationEndpoint: "https://mcp-auth.ashbyhq.com/oidc/auth",
          tokenEndpoint: "https://mcp-auth.ashbyhq.com/oidc/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["openid", "mcp", "offline_access"],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.ashbyhq.com/ashby-mcp-server-beta",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          describe_object_fields get_candidate get_interview_details get_interview_plan
          get_job_pipeline get_pending_tasks get_submitted_feedback get_upcoming_interviews
          search_product_docs search_records_by_name
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "lattice",
      displayName: "Lattice",
      category: "people-operations",
      server: {
        url: "https://api.latticehq.com/mcp",
        resource: "https://api.latticehq.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://partner-auth.latticehq.com",
          authorizationEndpoint: "https://api-auth.latticehq.com/oauth2/auth",
          tokenEndpoint: "https://api-auth.latticehq.com/oauth2/token",
          revocationEndpoint: "https://partner-auth.latticehq.com/oauth2/revoke",
          authorizationServerMetadataUrl:
            "https://api-auth.latticehq.com/.well-known/oauth-authorization-server",
          protectedResourceAuthorizationServer: "https://api-auth.latticehq.com",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [
            "mcp:employees.read",
            "mcp:feedback.read",
            "mcp:feedback.write",
            "mcp:goals.read",
            "mcp:grow.read",
            "mcp:meetings.read",
            "mcp:meetings.write",
            "mcp:reviews.read",
            "mcp:reviews.write",
            "mcp:updates.read",
            "mcp:updates.write",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://lattice.com/blog/introducing-lattice-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          find-ancestors find-employees find-feedback find-one-on-ones find-reports find-reviews
          get-review-cycles list-departments list-goals-for-employee
          list-grow-competencies-for-employee list-updates-for-employee whoami
        `,
          destructive: `give-feedback submit-review submit-update`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "deel",
      displayName: "Deel",
      category: "people-operations",
      server: {
        url: "https://api.letsdeel.com/mcp",
        resource: "https://api.letsdeel.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://api.letsdeel.com",
          authorizationEndpoint: "https://api.letsdeel.com/oauth/authorize",
          tokenEndpoint: "https://api.letsdeel.com/oauth/tokens",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.deel.com/mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          GetCustomFieldValuesFromWorker checkVisaRequirement
          downloadEmployeeComplianceDocumentTemplate downloadSubmittedComplianceDocument
          getAdjustments getContractPaymentDates getCurrentOrganization
          getCustomFieldFromPeopleById getCustomFieldsFromPeople getDetailedPaymentsReport
          getEORContractBenefits getEORWorkerPayslips getEorCountryValidations
          getGPWorkerPayslips getHrisOrganizationStructures getHrisProfilePerson getInvoiceById
          getInvoiceList getLegalEntityList getListOfPeople getLoggedInUserProfile getLookups
          getOffCyclePaymentByContractId getOffCyclePaymentsByContractId
          getOnboardingDetailsByEmployeeHrisProfileId getPolicyValidationTemplates
          getProfileEntitlements getShiftByExternalId getShiftRateByExternalId getShiftRates
          getShifts getTeamList getTimeOffPolicies getTimeOffRequests getTimeoffTypeList
          listBackgroundChecksByContract listContractAmendments listItAssets
          listItHardwarePolicies listItOrders listOfContracts listOfEmployeeComplianceDocuments
          listOnboardingEmployees retrieveAListOfAtsOffers retrieveAPaymentBreakdown
          retrieveASingleContract retrieveAnItAsset retrieveAtsJobPostingsByOrganization
          retrieveBenefitsByCountry retrieveBenefitsForEmployee
          retrieveContractAdditionalCostsForEOR retrieveContractFormForEOR retrieveCountries
          retrieveDeelInvoices retrieveEorContractDetails retrieveJobTitles
          retrievePaymentReceipts retrieveSeniorityLevels retrieveSupportedCurrencies
        `,
          destructive: `AddOffCyclePaymentForContract cancelTimeOffRequest signContract`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "bamboohr",
      displayName: "BambooHR",
      category: "people-operations",
      server: {
        url: "https://{tenant}.bamboohr.com/api/mcp",
        tenant: { label: "BambooHR company subdomain", hostSuffixes: ["bamboohr.com"] },
        resource: "https://{tenant}.bamboohr.com/api/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://{tenant}.bamboohr.com",
          authorizationEndpoint:
            "https://{tenant}.bamboohr.com/authorize.php?request=authorize&v=2",
          tokenEndpoint: "https://{tenant}.bamboohr.com/token.php?request=token",
          registrationMethods: ["pre_registered", "client_id_metadata_document"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [],
          issParameterSupported: true,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://documentation.bamboohr.com/docs/mcp-server",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          calculate_date get_alignable_goal_options get_application_details get_applications
          get_bhr_global_worker get_data_from_dataset_v2 get_employee get_employee_table_data
          get_employees_directory get_field_options_v1_2 get_fields_from_dataset_v1_2
          get_goal_aggregate get_goals_aggregate_v1_2 get_goals_filters_v1_2 get_job_summaries
          get_remote_contractor_eligibility_questionnaire_schema get_remote_employment
          get_remote_global_employment_pricing_summary get_remote_json_schema get_report_by_id
          get_statuses get_time_off_balance list_bhr_global_workers list_company_files
          list_datasets_v1_2 list_employee_files list_employee_time_off_policies_v1_1
          list_employees list_fields list_goal_comments list_goals list_list_fields
          list_remote_employment_onboarding_steps list_remote_employments list_reports
          list_supported_countries list_tabular_fields list_time_off_policies
          list_time_off_requests list_time_off_types list_whos_out
        `,
          destructive: `delete_goal delete_goal_comment update_time_off_request_status`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "vanta",
      displayName: "Vanta",
      category: "people-operations",
      server: {
        url: "https://mcp.vanta.com/mcp",
        resource: "https://mcp.vanta.com",
        authorization: {
          kind: "oauth",
          issuer: "https://api.vanta.com/mcp",
          authorizationEndpoint: "https://api.vanta.com/oauth/authorize",
          tokenEndpoint: "https://api.vanta.com/oauth/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none"],
          scopes: ["mcp-api.all:write"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developer.vanta.com/docs/vanta-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          download_document_file getAgentRemediationPrompt get_trust_center
          get_trust_center_document get_trust_center_resource_media get_trust_center_subscriber
          get_vendor_security_review list_control_documents list_control_tests
          list_discovered_vendor_accounts list_discovered_vendors list_framework_controls
          list_group_people list_library_controls list_test_entities
          list_trust_center_historical_access_requests list_trust_center_resources
          list_trust_center_subscribers list_trust_center_viewer_activity_events
          list_vendor_risk_attributes list_vendor_security_review_documents
          list_vulnerability_remediations
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "drata",
      displayName: "Drata",
      category: "people-operations",
      server: {
        url: "https://mcp.drata.com/mcp/",
        resource: "https://mcp.drata.com",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.drata.com/auth0-proxy",
          authorizationEndpoint: "https://mcp.drata.com/auth0-proxy/authorize",
          tokenEndpoint: "https://drata-prod.us.auth0.com/oauth/token",
          revocationEndpoint: "https://drata-prod.us.auth0.com/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: [
            "openid",
            "profile",
            "email",
            "offline_access",
            "read:controls",
            "read:monitor-test",
            "read:policy",
            "read:assigned-policies",
            "read:risk",
            "read:risk-registers",
            "create:risk",
            "update:risk",
            "delete:risk",
            "read:workspace",
            "read:company",
            "read:users",
            "read:user",
            "update:control",
            "create:control",
            "read:framework",
            "read:evidence",
            "create:evidence",
            "update:evidence",
            "delete:evidence",
            "read:vendor",
            "read:vendor-security-review",
            "read:vendor-document",
            "read:personnel",
            "update:personnel",
            "read:device",
            "create:background-checks",
            "create:user-document",
            "create-restricted:personnel",
            "create:vendor",
            "update:vendor",
            "delete:vendor",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://help.drata.com/en/articles/13379899-drata-mcp-setup-usage-guide",
        reviewedAt: REVIEWED_AT,
        toolEffects: {},
      },
    }),
    vendorMcpOAuthProvider({
      key: "docusign",
      displayName: "Docusign",
      category: "people-operations",
      server: {
        url: "https://mcp.docusign.com/mcp",
        resource: "https://mcp.docusign.com/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://account.docusign.com",
          authorizationEndpoint: "https://account.docusign.com/oauth/auth",
          tokenEndpoint: "https://account.docusign.com/oauth/token",
          authorizationServerMetadataUrl:
            "https://mcp.docusign.com/.well-known/oauth-authorization-server",
          protectedResourceAuthorizationServer: "https://mcp.docusign.com",
          registrationMethods: ["pre_registered"],
          tokenEndpointAuthMethods: ["client_secret_basic"],
          scopes: [
            "adm_store_unified_repo_read",
            "aow_manage",
            "cors",
            "signature",
            "spring_read",
            "spring_write",
          ],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.docusign.com/platform/mcp-server/",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          discoverDVApps getAccount getAgreementDetails getAgreementFilterSkill getAllAgreements
          getBillingPlan getBrand getBrands getClmWorkflowDefinitions getEnvelope
          getEnvelopeVsAgreementSkill getEnvelopes getTabGroups getTemplates getUser getUserInfo
          getUsers getWorkflowInstance getWorkflowInstancesList getWorkflowsList
          listBillingPlans listRecipients searchDocusignDocs suggestBestPractices
        `,
          destructive: `
          cancelWorkflowInstance createEnvelope createEnvelopeWithDocuments sendReminder
          stopClmWorkflow updateEnvelope updateEnvelopeRecipients
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "pandadoc",
      displayName: "PandaDoc",
      category: "people-operations",
      server: {
        url: "https://mcp.pandadoc.com/v1/mcp",
        resource: "https://mcp.pandadoc.com/v1/mcp",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.pandadoc.com/",
          authorizationEndpoint: "https://mcp.pandadoc.com/authorize",
          tokenEndpoint: "https://mcp.pandadoc.com/token",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post", "client_secret_basic"],
          scopes: ["read", "write"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.pandadoc.com/docs/getting-started-with-mcp",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          documents_content_get documents_details_get documents_list documents_metadata_get
          documents_search documents_status_get documents_summary_get templates_details_get
          templates_list
        `,
          destructive: `documents_send documents_status_change`,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "zapier",
      displayName: "Zapier",
      category: "automation",
      server: {
        url: "https://mcp.zapier.com/api/v1/connect",
        resource: "https://mcp.zapier.com/api/v1/connect",
        authorization: {
          kind: "oauth",
          issuer: "https://mcp.zapier.com",
          authorizationEndpoint: "https://mcp.zapier.com/oauth/authorize",
          tokenEndpoint: "https://mcp.zapier.com/api/v1/oauth/token",
          revocationEndpoint: "https://mcp.zapier.com/api/v1/oauth/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
          scopes: ["openid", "profile", "email"],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://docs.zapier.com/mcp/get-started/connect",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          discover_zapier_actions get_configuration_url get_workflow get_workflow_version
          get_zapier_skill inspect_zapier_actions list_workflow_drafts list_workflow_runs
          list_workflow_versions list_workflows list_zapier_connections list_zapier_skills
          search_triggers
        `,
          destructive: `
          delete_workflow delete_zapier_skill discard_workflow_draft execute_zapier_write_action
          write_code_action
        `,
        }),
      },
    }),
    vendorMcpOAuthProvider({
      key: "make",
      displayName: "Make",
      category: "people-operations",
      server: {
        url: "https://mcp.make.com",
        resource: "https://mcp.make.com/",
        authorization: {
          kind: "oauth",
          issuer: "https://www.make.com/mcp",
          authorizationEndpoint: "https://www.make.com/oauth/v2/authorize",
          tokenEndpoint: "https://www.make.com/oauth/v2/token",
          revocationEndpoint: "https://www.make.com/oauth/v2/revoke",
          registrationMethods: ["pre_registered", "dynamic_client_registration"],
          tokenEndpointAuthMethods: ["client_secret_post"],
          scopes: [],
          issParameterSupported: false,
          protectedResourceMetadata: "published",
        },
        documentationUrl: "https://developers.make.com/mcp-server/connect-using-oauth",
        reviewedAt: REVIEWED_AT,
        toolEffects: vendorMcpToolEffects({
          read: `
          app-module_get app_documentation_get app_modules_list apps_recommend audit-logs_get
          audit-logs_get-filters audit-logs_get-filters-for-team audit-logs_list
          audit-logs_list-for-team connected-system_get connected-system_list
          connected-system_list-apps connections_get connections_list credential-requests_get
          credential-requests_list credential-requests_list-app-modules-with-creds
          credential_requests_get data-stores_get data-stores_list data-structures_get
          data-structures_list devices_list executions_get executions_get-detail executions_list
          folders_list functions_check functions_get functions_list hook-incomings_get
          hook-incomings_list hook-incomings_stats hooks_get hooks_list
          incomplete-executions_get incomplete-executions_list keys_get keys_list
          organizations_get organizations_list private-spaces_get private-spaces_list
          public-templates_get public-templates_get-blueprint public-templates_list roles_get
          roles_list scenario-labels_list scenarios_get scenarios_list sdk-apps_get
          sdk-apps_get-common sdk-apps_get-docs sdk-apps_get-icon sdk-apps_get-section
          sdk-apps_list sdk-connections_get sdk-connections_get-common
          sdk-connections_get-section sdk-connections_list sdk-endpoints_get
          sdk-endpoints_get-section sdk-endpoints_list sdk-functions_get sdk-functions_get-code
          sdk-functions_get-test sdk-functions_list sdk-modules_get sdk-modules_get-section
          sdk-modules_list sdk-rpcs_get sdk-rpcs_get-section sdk-rpcs_list sdk-webhooks_get
          sdk-webhooks_get-section sdk-webhooks_list show_execution_result show_executions_list
          show_scenarios_list teams_get teams_list templates_get templates_get-blueprint
          templates_list users_me validate_blueprint_schema validate_module_configuration
        `,
          destructive: `
          connected-system_delete connections_delete connections_update
          credential-requests_credential-decline credential-requests_credential-delete
          credential-requests_delete custom-property-structure-items_delete
          custom-property-structure-items_update custom-roles_delete custom-roles_update
          data-store-records_delete data-store-records_replace data-store-records_update
          data-stores_delete data-stores_update data-structures_delete data-structures_update
          folders_delete folders_update functions_delete functions_update hook-incomings_delete
          hooks_delete hooks_update keys_delete keys_update on-prem-agent_delete
          organizations_delete organizations_update private-spaces_update
          scenario-custom-properties_delete scenario-custom-properties_replace
          scenario-labels_delete scenario-labels_unassign scenario-labels_update
          scenarios_delete scenarios_replay scenarios_run scenarios_update sdk-apps_delete
          sdk-connections_delete sdk-endpoints_delete sdk-functions_delete sdk-modules_delete
          sdk-rpcs_delete sdk-rpcs_test sdk-webhooks_delete teams_delete templates_delete
          templates_update
        `,
        }),
      },
    }),
  ]);
