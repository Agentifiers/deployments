mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = { execution_arn = "arn:aws:execute-api:us-east-2:123456789012:mockapi" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-2:123456789012:rule/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-2:123456789012:log-group:mock" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-east-2:123456789012:function:mock" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-2:123456789012:governance-queue"
      url = "https://sqs.us-east-2.amazonaws.com/123456789012/governance-queue"
    }
  }
  mock_resource "aws_ssm_parameter" {
    defaults = { arn = "arn:aws:ssm:us-east-2:123456789012:parameter/api/system-operator-configuration" }
  }
}

variables {
  account_id                      = "123456789012"
  agent_email_api_enabled         = true
  alarm_topic_arn                 = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
  agent_email_api_function_name   = "agent-email-api"
  agent_email_api_invoke_arn      = "arn:aws:apigateway:us-east-2:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-2:123456789012:function:agent-email-api/invocations"
  agent_email_bucket_arn          = "arn:aws:s3:::agent-email-123456789012"
  agent_email_bucket_name         = "agent-email-123456789012"
  artifact_bucket                 = "artifacts-123456789012"
  artifact_key                    = "platform-api.zip"
  artifact_version                = "version-1"
  automation_scheduler_group_name = "automations"
  brain_erasure_function_arn      = "arn:aws:lambda:us-east-2:123456789012:function:brain-search-erasure-fn"
  brain_erasure_function_name     = "brain-search-erasure-fn"
  brain_runtime_policy_arn        = "arn:aws:iam::123456789012:policy/brain-query"
  brain_runtime_environment_variables = {
    DEPLOYMENTS_AI_BRAIN_ANSWER_MODEL           = "openai/gpt-6-answers"
    DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT    = "https://vpc-search-abcdefghijklmnopqrstuvwxyz.us-east-2.es.amazonaws.com"
    DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS   = "openai/gpt-5.6-fallback"
    DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON = "[\"legacy-platform-environment-123456789012-artifacts\"]"
  }
  certificate_arn                 = "arn:aws:acm:us-east-2:123456789012:certificate/11111111-1111-1111-1111-111111111111"
  control_table_arn               = "arn:aws:dynamodb:us-east-2:123456789012:table/control"
  control_table_name              = "control"
  data_kms_key_arn                = "arn:aws:kms:us-east-2:123456789012:key/22222222-2222-2222-2222-222222222222"
  detailed_metrics_enabled        = false
  device_authorization_client_id  = "platform-cli-app"
  device_authorization_issuer     = "https://auth.dev.platform.example"
  domain_name                     = "api.dev.platform.example"
  durable_streams_auth_secret_arn = "arn:aws:secretsmanager:us-east-2:123456789012:secret:durable-streams-AbCdEf"
  durable_streams_base_url        = "http://durable-streams.internal"
  environment                     = "dev"
  evaluation_queue_arn            = "arn:aws:sqs:us-east-2:123456789012:agent-runtime-evaluations.fifo"
  evaluation_queue_url            = "https://sqs.us-east-2.amazonaws.com/123456789012/agent-runtime-evaluations.fifo"
  events_table_arn                = "arn:aws:dynamodb:us-east-2:123456789012:table/events"
  events_table_name               = "events"
  governance_bucket_arn           = "arn:aws:s3:::governance-123456789012"
  governance_bucket_name          = "governance-123456789012"
  governance_signing_key_arn      = "arn:aws:kms:us-east-2:123456789012:key/33333333-3333-3333-3333-333333333333"
  identity_email_kms_key_arn      = "arn:aws:kms:us-east-2:123456789012:key/22222222-2222-2222-2222-222222222222"
  identity_email_table_arn        = "arn:aws:dynamodb:us-east-2:123456789012:table/identity-email-outbox"
  identity_email_table_name       = "identity-email-outbox"
  identity_federation = {
    kms_key_arn = "arn:aws:kms:us-east-2:123456789012:key/44444444-4444-4444-4444-444444444444"
  }
  identity_table_arn  = "arn:aws:dynamodb:us-east-2:123456789012:table/identity"
  identity_table_name = "identity"
  principal_status_function = {
    arn  = "arn:aws:lambda:us-east-2:123456789012:function:deployments-ai-dev-identity-principal-status"
    name = "deployments-ai-dev-identity-principal-status"
  }
  jwt_audience                   = "https://api.dev.platform.example"
  jwt_claim_profile              = "platform"
  jwt_issuer                     = "https://auth.dev.platform.example"
  legacy_governance_bucket_arns  = ["arn:aws:s3:::legacy-platform-environment-123456789012-governance"]
  legacy_governance_bucket_names = ["legacy-platform-environment-123456789012-governance"]
  legacy_platform_artifact_bucket_arns = [
    "arn:aws:s3:::legacy-platform-environment-123456789012-artifacts",
  ]
  legacy_platform_artifact_bucket_names = ["legacy-platform-environment-123456789012-artifacts"]
  log_retention_in_days                 = 30
  memory_api_function_name              = "memory-api"
  memory_api_invoke_arn                 = "arn:aws:apigateway:us-east-2:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-2:123456789012:function:memory-api/invocations"
  memory_erasure_function_arn           = "arn:aws:lambda:us-east-2:123456789012:function:memory-erasure-fn"
  memory_erasure_function_name          = "memory-erasure-fn"
  memory_jwt_audience                   = ["https://api.dev.platform.example"]
  memory_jwt_issuer                     = "https://auth.dev.platform.example"
  memory_jwt_jwks_uri                   = "https://auth.dev.platform.example/.well-known/jwks.json"
  model_gateway_base_url                = "http://internal-models-internal-1234567890.us-east-2.elb.amazonaws.com"
  model_gateway_token_issuer = {
    arn           = "arn:aws:lambda:us-east-2:123456789012:function:agent-runtime-model-token-brain"
    function_name = "agent-runtime-model-token-brain"
  }
  model_grants_parameter_arn      = "arn:aws:ssm:us-east-2:123456789012:parameter/models/model-grants-json"
  oauth_apps_json                 = "{}"
  oauth_public_origin             = "https://abcdefghij.execute-api.us-east-2.amazonaws.com"
  oauth_refresh_function_arn      = "arn:aws:lambda:us-east-2:123456789012:function:oauth-refresh"
  oauth_refresh_function_name     = "oauth-refresh"
  oauth_return_origins            = ["https://app.dev.platform.example"]
  observability_base_url          = "http://hot-plane.observability.internal:3000"
  observability_secret_arn        = "arn:aws:ssm:us-east-2:123456789012:parameter/agent-observability/hot-plane/service-token"
  observability_secret_version_id = "12"
  platform_artifact_bucket_arn    = "arn:aws:s3:::artifacts-123456789012"
  platform_artifact_bucket_name   = "artifacts-123456789012"
  request_admission_table_arn     = "arn:aws:dynamodb:us-east-2:123456789012:table/request-admission"
  request_admission_table_name    = "request-admission"
  route53_zone_id                 = "Z0000000000000000000"
  runtime_api_function_name       = "agent-runtime-api"
  runtime_api_invoke_arn          = "arn:aws:apigateway:us-east-2:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-2:123456789012:function:agent-runtime-api/invocations"
  system_observer_role_arns = [
    "arn:aws:iam::123456789012:role/platform-observer",
    "arn:aws:iam::123456789012:role/vendor/install-reader",
  ]
  default_model_spend_ceiling_usd_micros    = 5000000
  organization_creation_quota_per_principal = 3
  system_service_principals = {
    billing = {
      role_arn = "arn:aws:iam::123456789012:role/hosted/billing-service"
      grants   = ["organization-read", "organization-holds", "organization-entitlements"]
    }
    abuse-desk = {
      role_arn = "arn:aws:iam::123456789012:role/trust-and-safety/abuse-desk-operator"
      grants   = ["organization-read", "organization-holds"]
    }
  }
  tenant_limit_defaults_json = "{\"active_sandboxes\":8,\"api_request_burst\":40,\"api_requests_per_second\":20,\"concurrent_runs\":8}"
  test_fixtures_enabled      = false
  throttling_burst_limit     = 100
  throttling_rate_limit      = 50
  usage_table_arn            = "arn:aws:dynamodb:us-east-2:123456789012:table/usage"
  usage_table_name           = "usage"
  apps_runtime = {
    domain_reconciler_invoke_policy_arn = "arn:aws:iam::123456789012:policy/apps-domain-reconciler-invoke"
    environment = {
      APPS_BUCKET                          = "apps-dev-123456789012"
      APPS_CUSTOM_DOMAIN_TARGET            = "d1234567890abc.cloudfront.net"
      APPS_DATABASE_FUNCTION_NAME          = "apps-database"
      APPS_DOMAIN                          = "apps.dev.platform.example"
      APPS_DOMAIN_RECONCILER_FUNCTION_NAME = "apps-domains"
      APPS_RESERVED_HOSTNAMES              = "api.dev.platform.example,auth.dev.platform.example,app.dev.platform.example,streams.dev.platform.example"
    }
    export_read_policy_arn = "arn:aws:iam::123456789012:policy/apps-export-read"
    invoke_policy_arn      = "arn:aws:iam::123456789012:policy/apps-database-invoke"
  }
  dynamodb_table_arns = {
    control   = "arn:aws:dynamodb:us-east-2:123456789012:table/control"
    events    = "arn:aws:dynamodb:us-east-2:123456789012:table/events"
    execution = "arn:aws:dynamodb:us-east-2:123456789012:table/execution"
    usage     = "arn:aws:dynamodb:us-east-2:123456789012:table/usage"
  }
  dynamodb_table_names = {
    control   = "control"
    events    = "events"
    execution = "execution"
    usage     = "usage"
  }
}

run "every_api_function_environment_fits_with_install_length_values" {
  command = plan

  assert {
    condition = alltrue([
      for function in aws_lambda_function.api : length(setsubtract([
        "DEPLOYMENTS_AI_API_IDEMPOTENCY_KMS_KEY_ARN",
        "DEPLOYMENTS_AI_API_JWT_AUDIENCE",
        "DEPLOYMENTS_AI_API_JWT_CLAIM_PROFILE",
        "DEPLOYMENTS_AI_API_JWT_ISSUER",
        "DEPLOYMENTS_AI_ARTIFACT_BUCKET",
        "DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN",
        "DEPLOYMENTS_AI_CONTROL_TABLE",
        "DEPLOYMENTS_AI_EVENTS_TABLE",
        "DEPLOYMENTS_AI_EXECUTION_TABLE",
        "DEPLOYMENTS_AI_IDENTITY_EMAIL_OUTBOX_TABLE",
        "DEPLOYMENTS_AI_IDENTITY_TABLE",
        "DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN",
        "DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS",
        "DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE",
        "DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS",
        "DEPLOYMENTS_AI_USAGE_TABLE",
      ], keys(function.environment[0].variables))) == 0
    ])
    error_message = "Every API function must receive the variables the shared API foundation reads."
  }

  assert {
    condition = alltrue([
      for function, names in {
        administration = [
          "DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN",
          "DEPLOYMENTS_AI_OAUTH_REFRESH_FUNCTION_NAME",
          "PLATFORM_OAUTH_APPS_JSON",
          "PLATFORM_OAUTH_PUBLIC_ORIGIN",
          "PLATFORM_OAUTH_RETURN_ORIGINS",
        ]
        brain = [
          "DEPLOYMENTS_AI_BRAIN_ANSWER_MODEL",
          "DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT",
          "DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS",
          "DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON",
          "DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL",
          "DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER",
        ]
        evaluations = ["DEPLOYMENTS_AI_EVALUATION_QUEUE_URL"]
        governance = [
          "DEPLOYMENTS_AI_BRAIN_ERASURE_FUNCTION_NAME",
          "DEPLOYMENTS_AI_GOVERNANCE_BUCKET",
          "DEPLOYMENTS_AI_GOVERNANCE_QUEUE_URL",
          "DEPLOYMENTS_AI_GOVERNANCE_SIGNING_KEY_ARN",
          "DEPLOYMENTS_AI_LEGACY_GOVERNANCE_BUCKETS_JSON",
          "DEPLOYMENTS_AI_MEMORY_ERASURE_FUNCTION_NAME",
        ]
        observability = [
          "DEPLOYMENTS_AI_OBSERVABILITY_BASE_URL",
          "DEPLOYMENTS_AI_OBSERVABILITY_SECRET_ARN",
          "DEPLOYMENTS_AI_OBSERVABILITY_SECRET_VERSION_ID",
        ]
        system = [
          "DEPLOYMENTS_AI_AWS_ACCOUNT_ID",
          "DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS",
          "DEPLOYMENTS_AI_PRINCIPAL_STATUS_FUNCTION_NAME",
          "DEPLOYMENTS_AI_SYSTEM_OBSERVER_ROLE_ARNS",
          "DEPLOYMENTS_AI_SYSTEM_OPERATOR_PARAMETER_ARN",
          "DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS",
        ]
        tenancy = [
          "APPS_BUCKET",
          "APPS_CUSTOM_DOMAIN_TARGET",
          "APPS_DATABASE_FUNCTION_NAME",
          "APPS_DOMAIN",
          "APPS_DOMAIN_RECONCILER_FUNCTION_NAME",
          "APPS_RESERVED_HOSTNAMES",
          "DEPLOYMENTS_AI_AGENT_EMAIL_API_ENABLED",
          "DEPLOYMENTS_AI_AWS_ACCOUNT_ID",
          "DEPLOYMENTS_AI_DEVICE_AUTHORIZATION_CLIENT_ID",
          "DEPLOYMENTS_AI_DEVICE_AUTHORIZATION_ISSUER",
          "DEPLOYMENTS_AI_IDENTITY_EMAIL_KMS_KEY_ID",
          "DEPLOYMENTS_AI_IDENTITY_FEDERATION_KMS_KEY_ID",
          "DEPLOYMENTS_AI_MEMORY_JWKS_URI",
          "DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCE",
          "DEPLOYMENTS_AI_MEMORY_JWT_ISSUER",
          "DEPLOYMENTS_AI_OAUTH_REFRESH_FUNCTION_NAME",
          "DEPLOYMENTS_AI_ORGANIZATION_CREATION_QUOTA_PER_PRINCIPAL",
          "DEPLOYMENTS_AI_PRINCIPAL_STATUS_FUNCTION_NAME",
          "DEPLOYMENTS_AI_STAGE",
          "DEPLOYMENTS_AI_SYSTEM_OBSERVER_ROLE_ARNS",
          "DEPLOYMENTS_AI_SYSTEM_OPERATOR_PARAMETER_ARN",
          "PLATFORM_OAUTH_APPS_JSON",
          "PLATFORM_OAUTH_PUBLIC_ORIGIN",
          "PLATFORM_OAUTH_RETURN_ORIGINS",
        ]
      } : length(setsubtract(names, keys(aws_lambda_function.api[function].environment[0].variables))) == 0
    ])
    error_message = "Each API function must receive every variable its handler reads."
  }
}

run "rejects_an_api_function_environment_over_the_limit" {
  command = plan

  variables {
    oauth_apps_json = "{\"padding\":\"${join("", [for index in range(400) : "0123456789"])}\"}"
  }

  expect_failures = [aws_lambda_function.api]
}

run "creates_no_model_credential_key_without_providers" {
  command = plan

  assert {
    condition     = length(aws_kms_key.model_credentials_unprotected) + length(aws_kms_key.model_credentials_protected) == 0 && output.model_credential_kms_key_arn == null
    error_message = "An install without model credential providers must not create the model credential key."
  }

  assert {
    condition     = !contains(keys(aws_lambda_function.api["tenancy"].environment[0].variables), "DEPLOYMENTS_AI_MODEL_CREDENTIAL_PROVIDERS")
    error_message = "An install without model credential providers must not enable the routes."
  }
}

run "lets_the_api_only_seal_model_credentials" {
  command = plan

  variables {
    model_credentials = {
      deletion_protection_enabled = true
      kms_deletion_window_in_days = 7
      providers                   = ["openai", "openrouter"]
    }
  }

  assert {
    condition     = length(aws_kms_key.model_credentials_protected) == 1 && length(aws_kms_key.model_credentials_unprotected) == 0
    error_message = "Deletion protection must select the protected model credential key."
  }

  assert {
    condition = jsondecode(aws_kms_key.model_credentials_protected[0].policy).Statement[1] == {
      Sid       = "SealModelProviderCredentials"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::123456789012:role/mock" }
      Action    = ["kms:GenerateDataKey"]
      Resource  = "*"
      Condition = {
        StringEquals = { "kms:EncryptionContext:purpose" = "model-provider-credential" }
        "ForAllValues:StringEquals" = {
          "kms:EncryptionContextKeys" = ["credentialId", "keyVersion", "organizationId", "provider", "purpose", "stage"]
        }
      }
    }
    error_message = "The API role may only generate data keys for model credentials."
  }

  assert {
    condition = length(jsondecode(aws_kms_key.model_credentials_protected[0].policy).Statement) == 2 && length(setintersection(
      jsondecode(aws_kms_key.model_credentials_protected[0].policy).Statement[0].Action,
      ["kms:CreateGrant", "kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:ReEncryptFrom", "kms:ReEncryptTo", "kms:*"],
    )) == 0
    error_message = "The account may administer the model credential key but not use it."
  }

  assert {
    condition = {
      for name in ["DEPLOYMENTS_AI_MODEL_CREDENTIAL_PROVIDERS", "DEPLOYMENTS_AI_STAGE"] :
      name => aws_lambda_function.api["tenancy"].environment[0].variables[name]
      } == {
      DEPLOYMENTS_AI_MODEL_CREDENTIAL_PROVIDERS = "openai,openrouter"
      DEPLOYMENTS_AI_STAGE                      = "dev"
    }
    error_message = "The tenancy API must receive the enabled providers and the stage that binds sealed keys."
  }
}

run "lets_only_the_model_gateway_open_model_credentials" {
  command = plan

  variables {
    model_credentials = {
      deletion_protection_enabled = false
      gateway_role_arn            = "arn:aws:iam::123456789012:role/model-runtime-task"
      kms_deletion_window_in_days = 7
      providers                   = ["openai"]
    }
  }

  assert {
    condition = jsondecode(aws_kms_key.model_credentials_unprotected[0].policy).Statement[2] == {
      Sid       = "OpenModelProviderCredentials"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::123456789012:role/model-runtime-task" }
      Action    = ["kms:Decrypt"]
      Resource  = "*"
      Condition = {
        StringEquals = { "kms:EncryptionContext:purpose" = "model-provider-credential" }
        "ForAllValues:StringEquals" = {
          "kms:EncryptionContextKeys" = ["credentialId", "keyVersion", "organizationId", "provider", "purpose", "stage"]
        }
      }
    }
    error_message = "The model gateway task role may decrypt only model provider credentials."
  }

  assert {
    condition = [
      for statement in jsondecode(aws_kms_key.model_credentials_unprotected[0].policy).Statement :
      statement.Sid if contains(flatten([statement.Action]), "kms:Decrypt")
    ] == ["OpenModelProviderCredentials"]
    error_message = "No principal other than the model gateway may decrypt model provider credentials."
  }
}

run "rejects_bedrock_as_a_model_credential_provider" {
  command = plan

  variables {
    model_credentials = {
      deletion_protection_enabled = false
      kms_deletion_window_in_days = 7
      providers                   = ["bedrock"]
    }
  }

  expect_failures = [var.model_credentials]
}

run "omits_the_organization_creation_quota_when_unlimited" {
  command = plan

  variables {
    organization_creation_quota_per_principal = null
  }

  assert {
    condition     = !contains(keys(aws_lambda_function.api["tenancy"].environment[0].variables), "DEPLOYMENTS_AI_ORGANIZATION_CREATION_QUOTA_PER_PRINCIPAL")
    error_message = "An install without a quota must leave organization creation unlimited."
  }
}

run "rejects_a_negative_organization_creation_quota" {
  command = plan

  variables {
    organization_creation_quota_per_principal = -1
  }

  expect_failures = [var.organization_creation_quota_per_principal]
}

run "reaches_identity_only_through_the_principal_status_function" {
  command = plan

  assert {
    condition = [
      for statement in data.aws_iam_policy_document.lambda.statement : [statement.actions, statement.resources]
      if statement.sid == "InvokePrincipalStatus"
      ] == [[
        toset(["lambda:InvokeFunction"]),
        toset(["arn:aws:lambda:us-east-2:123456789012:function:deployments-ai-dev-identity-principal-status"]),
    ]]
    error_message = "The API role may invoke only platform identity's principal status function."
  }

  assert {
    condition     = aws_lambda_function.api["system"].environment[0].variables["DEPLOYMENTS_AI_PRINCIPAL_STATUS_FUNCTION_NAME"] == "deployments-ai-dev-identity-principal-status"
    error_message = "The system API must know which function changes a person's status."
  }
}

run "grants_no_principal_status_access_without_platform_identity" {
  command = plan

  variables {
    principal_status_function = null
  }

  assert {
    condition     = length([for statement in data.aws_iam_policy_document.lambda.statement : statement if statement.sid == "InvokePrincipalStatus"]) == 0
    error_message = "An install without platform identity must not grant the principal status invoke."
  }

  assert {
    condition     = !contains(keys(aws_lambda_function.api["system"].environment[0].variables), "DEPLOYMENTS_AI_PRINCIPAL_STATUS_FUNCTION_NAME")
    error_message = "An install without platform identity must not name a principal status function."
  }
}
