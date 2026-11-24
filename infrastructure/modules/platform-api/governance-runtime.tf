locals {
  # AWS caps a function's environment at 4 KiB. Every function gets only this shared map plus the
  # variables its own handler reads (api_environment); give a new variable to the functions whose
  # handler reads it, not to this map.
  api_shared_environment = merge({
    DEPLOYMENTS_AI_API_IDEMPOTENCY_KMS_KEY_ARN = var.data_kms_key_arn
    DEPLOYMENTS_AI_API_JWT_AUDIENCE            = var.jwt_audience
    DEPLOYMENTS_AI_API_JWT_CLAIM_PROFILE       = var.jwt_claim_profile
    DEPLOYMENTS_AI_API_JWT_ISSUER              = var.jwt_issuer
    DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN        = var.data_kms_key_arn
    DEPLOYMENTS_AI_ARTIFACT_BUCKET             = var.platform_artifact_bucket_name
    DEPLOYMENTS_AI_CONTROL_TABLE               = var.control_table_name
    DEPLOYMENTS_AI_EVENTS_TABLE                = var.events_table_name
    DEPLOYMENTS_AI_EXECUTION_TABLE             = var.dynamodb_table_names["execution"]
    DEPLOYMENTS_AI_IDENTITY_TABLE              = var.identity_table_name
    DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE     = var.request_admission_table_name
    DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS       = var.tenant_limit_defaults_json
    DEPLOYMENTS_AI_USAGE_TABLE                 = var.usage_table_name
    }, trimspace(var.identity_email_kms_key_arn) == "" ? {} : {
    DEPLOYMENTS_AI_IDENTITY_EMAIL_OUTBOX_TABLE = var.identity_email_table_name
    }, trimspace(var.model_grants_parameter_arn) == "" ? {} : {
    DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN = var.model_grants_parameter_arn
    }, var.default_model_spend_ceiling_usd_micros == null ? {} : {
    DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS = tostring(var.default_model_spend_ceiling_usd_micros)
  })

  api_oauth_environment = merge({
    PLATFORM_OAUTH_APPS_JSON      = var.oauth_apps_json
    PLATFORM_OAUTH_RETURN_ORIGINS = join(",", var.oauth_return_origins)
    }, trimspace(var.oauth_public_origin) == "" ? {} : {
    DEPLOYMENTS_AI_OAUTH_REFRESH_FUNCTION_NAME = var.oauth_refresh_function_name
    PLATFORM_OAUTH_PUBLIC_ORIGIN               = var.oauth_public_origin
  })

  api_system_environment = merge({
    DEPLOYMENTS_AI_SYSTEM_OPERATOR_PARAMETER_ARN = aws_ssm_parameter.system_operator.arn
    }, length(var.system_observer_role_arns) == 0 ? {} : {
    DEPLOYMENTS_AI_AWS_ACCOUNT_ID            = var.account_id
    DEPLOYMENTS_AI_SYSTEM_OBSERVER_ROLE_ARNS = join(",", var.system_observer_role_arns)
    }, var.principal_status_function == null ? {} : {
    DEPLOYMENTS_AI_PRINCIPAL_STATUS_FUNCTION_NAME = var.principal_status_function.name
  })

  api_standing_environment = length(var.system_service_principals) == 0 ? {} : {
    DEPLOYMENTS_AI_AWS_ACCOUNT_ID            = var.account_id
    DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS = jsonencode(var.system_service_principals)
  }

  api_environment = {
    administration = merge(local.api_shared_environment, local.api_oauth_environment, {
      DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN = var.data_kms_key_arn
    })
    brain = merge(local.api_shared_environment, {
      DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON = jsonencode(var.legacy_platform_artifact_bucket_names)
      }, var.brain_runtime_environment_variables, var.model_gateway_token_issuer == null ? {} : {
      DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL     = var.model_gateway_base_url
      DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER = var.model_gateway_token_issuer.function_name
    })
    budget   = local.api_shared_environment
    monitors = local.api_shared_environment
    evaluations = merge(local.api_shared_environment, {
      DEPLOYMENTS_AI_EVALUATION_QUEUE_URL = var.evaluation_queue_url
    })
    governance = merge(local.api_shared_environment, {
      DEPLOYMENTS_AI_BRAIN_ERASURE_FUNCTION_NAME    = var.brain_erasure_function_name
      DEPLOYMENTS_AI_GOVERNANCE_BUCKET              = var.governance_bucket_name
      DEPLOYMENTS_AI_GOVERNANCE_QUEUE_URL           = aws_sqs_queue.governance.url
      DEPLOYMENTS_AI_GOVERNANCE_SIGNING_KEY_ARN     = var.governance_signing_key_arn
      DEPLOYMENTS_AI_LEGACY_GOVERNANCE_BUCKETS_JSON = jsonencode(var.legacy_governance_bucket_names)
      DEPLOYMENTS_AI_MEMORY_ERASURE_FUNCTION_NAME   = var.memory_erasure_function_name
    })
    observability = merge(local.api_shared_environment, trimspace(var.observability_base_url) == "" ? {} : {
      DEPLOYMENTS_AI_OBSERVABILITY_BASE_URL          = var.observability_base_url
      DEPLOYMENTS_AI_OBSERVABILITY_SECRET_ARN        = var.observability_secret_arn
      DEPLOYMENTS_AI_OBSERVABILITY_SECRET_VERSION_ID = var.observability_secret_version_id
    })
    system = merge(local.api_shared_environment, local.api_system_environment, local.api_standing_environment)
    tenancy = merge(local.api_shared_environment, local.api_oauth_environment, local.api_system_environment, local.api_standing_environment, {
      DEPLOYMENTS_AI_AGENT_EMAIL_API_ENABLED = tostring(var.agent_email_api_enabled)
      DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCE     = jsonencode(var.memory_jwt_audience)
      DEPLOYMENTS_AI_MEMORY_JWT_ISSUER       = var.memory_jwt_issuer
      }, trimspace(var.memory_jwt_jwks_uri) == "" ? {} : {
      DEPLOYMENTS_AI_MEMORY_JWKS_URI = var.memory_jwt_jwks_uri
      }, trimspace(var.device_authorization_client_id) == "" ? {} : {
      DEPLOYMENTS_AI_DEVICE_AUTHORIZATION_CLIENT_ID = var.device_authorization_client_id
      DEPLOYMENTS_AI_DEVICE_AUTHORIZATION_ISSUER    = var.device_authorization_issuer
      }, trimspace(var.identity_email_kms_key_arn) == "" ? {} : {
      DEPLOYMENTS_AI_IDENTITY_EMAIL_KMS_KEY_ID = var.identity_email_kms_key_arn
      DEPLOYMENTS_AI_STAGE                     = var.environment
      }, var.identity_federation == null ? {} : {
      DEPLOYMENTS_AI_IDENTITY_FEDERATION_KMS_KEY_ID = var.identity_federation.kms_key_arn
      DEPLOYMENTS_AI_STAGE                          = var.environment
      }, var.organization_creation_quota_per_principal == null ? {} : {
      DEPLOYMENTS_AI_ORGANIZATION_CREATION_QUOTA_PER_PRINCIPAL = tostring(var.organization_creation_quota_per_principal)
      }, var.model_credentials == null ? {} : {
      DEPLOYMENTS_AI_MODEL_CREDENTIAL_KMS_KEY_ARN = local.model_credential_key_arn
      DEPLOYMENTS_AI_MODEL_CREDENTIAL_PROVIDERS   = join(",", var.model_credentials.providers)
      DEPLOYMENTS_AI_STAGE                        = var.environment
    }, var.apps_runtime == null ? {} : var.apps_runtime.environment)
  }
}

resource "aws_lambda_function" "api" {
  for_each = local.api_functions

  function_name                  = each.value.function_name
  description                    = "Platform API Lambda for the ${each.key} routes of the unified product gateway."
  architectures                  = ["arm64"]
  handler                        = each.value.handler
  memory_size                    = 512
  reserved_concurrent_executions = each.key == "tenancy" ? var.reserved_concurrency : -1
  role                           = aws_iam_role.lambda.arn
  runtime                        = "nodejs26.x"
  s3_bucket                      = var.artifact_bucket
  s3_key                         = var.artifact_key
  s3_object_version              = var.artifact_version
  timeout                        = 29

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]

    precondition {
      condition = (
        (trimspace(var.device_authorization_client_id) == "") ==
        (trimspace(var.device_authorization_issuer) == "")
      )
      error_message = "device_authorization_client_id and device_authorization_issuer must be configured together."
    }

    precondition {
      condition = (
        trimspace(var.device_authorization_client_id) == "" ||
        (
          (
            trimspace(var.jwt_claim_profile) == "platform" ||
            contains(local.jwt_audiences, trimspace(var.device_authorization_client_id))
          ) &&
          trimsuffix(trimspace(var.device_authorization_issuer), "/") == trimsuffix(trimspace(var.jwt_issuer), "/")
        )
      )
      error_message = "Device authorization must use the same issuer and a bearer audience accepted by the platform JWT authenticator."
    }

    precondition {
      condition = (
        (trimspace(var.oauth_public_origin) == "") ==
        (trimspace(var.oauth_refresh_function_name) == "") &&
        (trimspace(var.oauth_refresh_function_name) == "") ==
        (trimspace(var.oauth_refresh_function_arn) == "")
      )
      error_message = "oauth_public_origin, oauth_refresh_function_name, and oauth_refresh_function_arn must be configured together."
    }

    precondition {
      condition = (
        trimspace(var.identity_email_kms_key_arn) == "" ||
        (trimspace(var.identity_email_table_arn) != "" && trimspace(var.identity_email_table_name) != "")
      )
      error_message = "identity_email_table_arn and identity_email_table_name are required with identity_email_kms_key_arn."
    }

    # AWS enforces its 4 KiB environment limit (compact JSON) only at apply time. The margin
    # covers jsonencode escaping that may differ from AWS's measurement.
    precondition {
      condition     = length(jsonencode(local.api_environment[each.key])) <= 3900
      error_message = "The ${each.key} API Lambda environment is ${nonsensitive(length(jsonencode(local.api_environment[each.key])))} bytes as JSON; keep it at or below 3900 (AWS limit 4096). Give a variable only to the functions whose handler reads it, or move large values to an SSM parameter."
    }
  }

  environment {
    variables = local.api_environment[each.key]
  }

  dynamic "vpc_config" {
    for_each = var.network == null ? [] : [var.network]
    content {
      security_group_ids = [aws_security_group.api[0].id]
      subnet_ids         = vpc_config.value.private_subnet_ids
    }
  }

  tags = local.common_tags

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda,
    aws_iam_role_policy_attachment.brain_runtime,
    aws_iam_role_policy_attachment.system_operator,
  ]
}

moved {
  from = aws_lambda_function.api
  to   = aws_lambda_function.api["tenancy"]
}

resource "aws_sqs_queue" "governance_dlq" {
  name                      = "governance-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "governance" {
  name                       = "governance"
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 5400
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.governance_dlq.arn
    maxReceiveCount     = 5
  })
  tags = local.common_tags
}

resource "aws_lambda_function" "governance_worker" {
  function_name     = "governance-worker"
  description       = "Executes tenant exports, erasures, immutable audit exports, and retention sweeps."
  architectures     = ["arm64"]
  handler           = "governance-worker-main.handler"
  memory_size       = 2048
  role              = aws_iam_role.governance_worker.arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 900

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]

    precondition {
      condition     = (trimspace(var.observability_erasure_function_name) == "") == (trimspace(var.observability_erasure_function_arn) == "")
      error_message = "observability_erasure_function_name and observability_erasure_function_arn must be configured together."
    }
  }

  environment {
    variables = merge({
      DEPLOYMENTS_AI_AGENT_EMAIL_BUCKET              = var.agent_email_bucket_name
      DEPLOYMENTS_AI_LEGACY_AGENT_EMAIL_BUCKETS_JSON = jsonencode(var.legacy_agent_email_bucket_names)
      DEPLOYMENTS_AI_ARTIFACT_BUCKET                 = var.platform_artifact_bucket_name
      DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON    = jsonencode(var.legacy_platform_artifact_bucket_names)
      DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN            = var.data_kms_key_arn
      DEPLOYMENTS_AI_CONTROL_TABLE                   = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN = var.durable_streams_auth_secret_arn
      DEPLOYMENTS_AI_DURABLE_STREAMS_URL             = var.durable_streams_base_url
      DEPLOYMENTS_AI_EVENTS_TABLE                    = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE                 = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_GOVERNANCE_BUCKET               = var.governance_bucket_name
      DEPLOYMENTS_AI_LEGACY_GOVERNANCE_BUCKETS_JSON  = jsonencode(var.legacy_governance_bucket_names)
      DEPLOYMENTS_AI_GOVERNANCE_QUEUE_URL            = aws_sqs_queue.governance.url
      DEPLOYMENTS_AI_GOVERNANCE_SIGNING_KEY_ARN      = var.governance_signing_key_arn
      DEPLOYMENTS_AI_MEMORY_ERASURE_FUNCTION_NAME    = var.memory_erasure_function_name
      DEPLOYMENTS_AI_BRAIN_ERASURE_FUNCTION_NAME     = var.brain_erasure_function_name
      DEPLOYMENTS_AI_API_IDEMPOTENCY_KMS_KEY_ARN     = var.data_kms_key_arn
      DEPLOYMENTS_AI_SCHEDULER_GROUP                 = var.automation_scheduler_group_name
      DEPLOYMENTS_AI_USAGE_TABLE                     = var.dynamodb_table_names["usage"]
      }, var.agent_observability_quarantine_bucket_name == null ? {} : {
      DEPLOYMENTS_AI_OBSERVABILITY_QUARANTINE_BUCKET = var.agent_observability_quarantine_bucket_name
      }, trimspace(var.observability_erasure_function_name) == "" ? {} : {
      DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_FUNCTION_NAME = var.observability_erasure_function_name
    }, var.apps_runtime == null ? {} : var.apps_runtime.environment)
  }

  dynamic "vpc_config" {
    for_each = var.network == null ? [] : [var.network]
    content {
      security_group_ids = [aws_security_group.governance_worker[0].id]
      subnet_ids         = vpc_config.value.private_subnet_ids
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.governance_worker,
    aws_iam_role_policy.governance_worker,
  ]
  tags = local.common_tags
}

resource "aws_lambda_event_source_mapping" "governance" {
  event_source_arn        = aws_sqs_queue.governance.arn
  function_name           = aws_lambda_function.governance_worker.arn
  batch_size              = 1
  enabled                 = true
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 5
  }
}

resource "aws_cloudwatch_event_rule" "governance_retention" {
  name                = "governance-retention"
  description         = "Runs organization retention policies once per day."
  schedule_expression = "rate(1 day)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "governance_retention" {
  arn   = aws_lambda_function.governance_worker.arn
  input = jsonencode({ kind = "retention-sweep" })
  rule  = aws_cloudwatch_event_rule.governance_retention.name
}

resource "aws_lambda_permission" "governance_retention" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.governance_worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.governance_retention.arn
  statement_id  = "AllowGovernanceRetentionSchedule"
}

# Also the next attempt of an operation a wait left pending (a search drain, an observability
# purge), so the interval bounds how long a tenant erasure sits idle after each wait ends. The
# sweep reads 32 index partitions, so running it every minute costs little.
resource "aws_cloudwatch_event_rule" "governance_operation_dispatch" {
  name                = "governance-operation-dispatch"
  description         = "Re-enqueues pending governance operations and those whose immediate dispatch was interrupted."
  schedule_expression = "rate(1 minute)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "governance_operation_dispatch" {
  arn   = aws_lambda_function.governance_worker.arn
  input = jsonencode({ kind = "operation-dispatch-sweep" })
  rule  = aws_cloudwatch_event_rule.governance_operation_dispatch.name
}

resource "aws_lambda_permission" "governance_operation_dispatch" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.governance_worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.governance_operation_dispatch.arn
  statement_id  = "AllowGovernanceOperationDispatchSchedule"
}
