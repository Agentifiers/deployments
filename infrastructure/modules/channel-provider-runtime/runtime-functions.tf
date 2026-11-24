resource "aws_lambda_function" "ingress" {
  function_name     = "channel-ingress"
  architectures     = ["arm64"]
  handler           = "ingress.handler"
  memory_size       = 256
  role              = aws_iam_role.runtime["channel-ingress"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 30

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = {
      DEPLOYMENTS_AI_CHANNEL_INGRESS_QUEUE_URL        = aws_sqs_queue.runtime["channel-ingress"].url
      DEPLOYMENTS_AI_CONTROL_TABLE                    = var.control_table_name
      DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN           = var.data_kms_key_arn
      DEPLOYMENTS_AI_CREDENTIAL_VAULT_READER_ROLE_ARN = aws_iam_role.credential_vault["reader"].arn
      DEPLOYMENTS_AI_EVENTS_TABLE                     = var.events_table_name
      DEPLOYMENTS_AI_EXECUTION_TABLE                  = var.execution_table_name
    }
  }
  tags       = local.common_tags
  depends_on = [aws_iam_role_policy.runtime, aws_cloudwatch_log_group.runtime]
}

resource "aws_lambda_function" "credential_api" {
  function_name     = "credential-api"
  architectures     = ["arm64"]
  handler           = "credentials.handler"
  memory_size       = 256
  role              = aws_iam_role.runtime["credential-api"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 30

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = {
      DEPLOYMENTS_AI_CONTROL_TABLE                    = var.control_table_name
      DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN           = var.data_kms_key_arn
      DEPLOYMENTS_AI_CREDENTIAL_VAULT_WRITER_ROLE_ARN = aws_iam_role.credential_vault["writer"].arn
      DEPLOYMENTS_AI_EVENTS_TABLE                     = var.events_table_name
    }
  }
  tags = local.common_tags
  depends_on = [
    aws_cloudwatch_log_group.runtime,
    aws_iam_role_policy.runtime,
    aws_iam_role_policy_attachment.credential_vault,
  ]
}

resource "aws_lambda_function" "oauth_api" {
  function_name     = "oauth-api"
  architectures     = ["arm64"]
  handler           = "oauth.handler"
  memory_size       = 256
  role              = aws_iam_role.runtime["oauth-api"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 30

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = {
      DEPLOYMENTS_AI_CONTROL_TABLE                    = var.control_table_name
      DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN           = var.data_kms_key_arn
      DEPLOYMENTS_AI_CREDENTIAL_VAULT_WRITER_ROLE_ARN = aws_iam_role.credential_vault["writer"].arn
      DEPLOYMENTS_AI_EVENTS_TABLE                     = var.events_table_name
      DEPLOYMENTS_AI_EXECUTION_TABLE                  = var.execution_table_name
      PLATFORM_OAUTH_APPS_JSON                        = var.oauth_apps_json
      PLATFORM_OAUTH_PUBLIC_ORIGIN                    = local.public_origin
      PLATFORM_OAUTH_RETURN_ORIGINS                   = join(",", var.oauth_return_origins)
    }
  }
  tags = local.common_tags
  depends_on = [
    aws_cloudwatch_log_group.runtime,
    aws_iam_role_policy.runtime,
    aws_iam_role_policy_attachment.credential_vault,
  ]
}

# IAM-invoked only (platform API and agent workers); deliberately has no HTTP route.
resource "aws_lambda_function" "oauth_refresh" {
  function_name     = "oauth-refresh"
  architectures     = ["arm64"]
  handler           = "oauth-refresh.handler"
  memory_size       = 256
  role              = aws_iam_role.runtime["oauth-refresh"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 30

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = {
      DEPLOYMENTS_AI_CONTROL_TABLE                    = var.control_table_name
      DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN           = var.data_kms_key_arn
      DEPLOYMENTS_AI_CREDENTIAL_VAULT_WRITER_ROLE_ARN = aws_iam_role.credential_vault["writer"].arn
      DEPLOYMENTS_AI_EVENTS_TABLE                     = var.events_table_name
      DEPLOYMENTS_AI_EXECUTION_TABLE                  = var.execution_table_name
      PLATFORM_OAUTH_APPS_JSON                        = var.oauth_apps_json
      PLATFORM_OAUTH_PUBLIC_ORIGIN                    = local.public_origin
    }
  }
  tags = local.common_tags
  depends_on = [
    aws_cloudwatch_log_group.runtime,
    aws_iam_role_policy.runtime,
    aws_iam_role_policy_attachment.credential_vault,
  ]
}

resource "aws_lambda_function" "worker" {
  for_each          = local.workers
  function_name     = each.key
  architectures     = ["arm64"]
  handler           = each.value.handler
  memory_size       = each.key == "provider-tools" ? 512 : 256
  role              = aws_iam_role.runtime[each.key].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = each.key == "provider-tools" ? 300 : 60

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]

    precondition {
      condition = (
        each.key != "channel-delivery" ||
        (
          trimspace(var.durable_streams_base_url) == "" &&
          trimspace(var.durable_streams_auth_secret_arn) == "" &&
          var.network == null
          ) || (
          trimspace(var.durable_streams_base_url) != "" &&
          trimspace(var.durable_streams_auth_secret_arn) != "" &&
          length(try(var.network.private_subnet_ids, [])) >= 2
        )
      )
      error_message = "Channel delivery Durable Streams publication requires its auth secret, VPC, and at least two private subnets."
    }
  }

  environment {
    variables = merge({
      DEPLOYMENTS_AI_CONTROL_TABLE                    = var.control_table_name
      DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN           = var.data_kms_key_arn
      DEPLOYMENTS_AI_CREDENTIAL_VAULT_READER_ROLE_ARN = aws_iam_role.credential_vault["reader"].arn
      DEPLOYMENTS_AI_EVENTS_TABLE                     = var.events_table_name
      DEPLOYMENTS_AI_EXECUTION_TABLE                  = var.execution_table_name
      }, each.key == "channel-delivery" && trimspace(var.durable_streams_base_url) != "" ? {
      DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN = var.durable_streams_auth_secret_arn
      DEPLOYMENTS_AI_DURABLE_STREAMS_URL             = var.durable_streams_base_url
    } : {})
  }

  dynamic "vpc_config" {
    for_each = each.key == "channel-delivery" && var.network != null ? [var.network] : []
    content {
      security_group_ids = [aws_security_group.delivery[0].id]
      subnet_ids         = vpc_config.value.private_subnet_ids
    }
  }
  tags       = local.common_tags
  depends_on = [aws_iam_role_policy.runtime, aws_cloudwatch_log_group.runtime]
}

resource "aws_lambda_event_source_mapping" "worker" {
  for_each         = local.workers
  event_source_arn = each.value.queue
  function_name    = aws_lambda_function.worker[each.key].arn
  batch_size       = each.key == "provider-tools" ? 1 : 10
  # No batching window: on low-traffic SQS queues any window makes Lambda wait up to 20 s (AWS docs).
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]
}
