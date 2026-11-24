resource "aws_lambda_function" "api" {
  function_name = "${local.name_prefix}-api"
  role          = aws_iam_role.worker.arn
  handler       = "runtime-api-main.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 29
  memory_size   = 1024

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]

    precondition {
      condition     = (trimspace(var.api_jwt_issuer) == "") == (trimspace(var.api_jwt_audience) == "")
      error_message = "api_jwt_issuer and api_jwt_audience must be configured together."
    }
  }

  reserved_concurrent_executions = var.api_reserved_concurrency

  environment {
    variables = local.public_runtime_environment
  }

  vpc_config {
    security_group_ids = [aws_security_group.worker.id]
    subnet_ids         = var.private_subnet_ids
  }

  depends_on = [
    aws_cloudwatch_log_group.api,
    aws_iam_role_policy.worker,
    aws_ssm_parameter.stream_session,
  ]
  tags = local.common_tags
}

locals {
  webhook_runtime_environment = {
    DEPLOYMENTS_AI_CONTROL_TABLE                   = var.dynamodb_table_names["control"]
    DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN          = var.data_kms_key_arn
    DEPLOYMENTS_AI_EVENTS_TABLE                    = var.dynamodb_table_names["events"]
    DEPLOYMENTS_AI_EXECUTION_TABLE                 = var.dynamodb_table_names["execution"]
    DEPLOYMENTS_AI_USAGE_TABLE                     = var.dynamodb_table_names["usage"]
    DEPLOYMENTS_AI_WEBHOOK_DELIVERY_QUEUE_URL      = aws_sqs_queue.webhook_deliveries.url
    DEPLOYMENTS_AI_WEBHOOK_DELIVERY_RETENTION_DAYS = tostring(var.webhook_delivery_retention_days)
  }
}

resource "aws_lambda_function" "webhook_events" {
  function_name                  = "${local.name_prefix}-webhook-events"
  description                    = "Fans committed semantic events out to webhook delivery records and queue messages."
  role                           = aws_iam_role.worker.arn
  handler                        = "webhook-event-handler.handler"
  runtime                        = "nodejs26.x"
  architectures                  = ["arm64"]
  timeout                        = 120
  memory_size                    = 512
  reserved_concurrent_executions = var.webhook_events_reserved_concurrency

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = local.webhook_runtime_environment
  }

  vpc_config {
    security_group_ids = [aws_security_group.worker.id]
    subnet_ids         = var.private_subnet_ids
  }

  depends_on = [
    aws_cloudwatch_log_group.webhook_events,
    aws_iam_role_policy.worker,
    aws_iam_role_policy_attachment.worker_runtime,
  ]
  tags = local.common_tags
}

# Same artifact and handler as webhook_events: SQS input runs one signed attempt per message.
# Egress leaves through the VPC NAT; the handler resolves and pins only public addresses.
resource "aws_lambda_function" "webhook_deliveries" {
  function_name = "${local.name_prefix}-webhook-deliveries"
  description   = "Sends one signed webhook attempt per queued delivery and schedules retries."
  role          = aws_iam_role.worker.arn
  handler       = "webhook-event-handler.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 120
  memory_size   = 512

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = local.webhook_runtime_environment
  }

  vpc_config {
    security_group_ids = [aws_security_group.worker.id]
    subnet_ids         = var.private_subnet_ids
  }

  depends_on = [
    aws_cloudwatch_log_group.webhook_deliveries,
    aws_iam_role_policy.worker,
    aws_iam_role_policy_attachment.worker_runtime,
  ]
  tags = local.common_tags
}

resource "aws_cloudwatch_event_rule" "webhook_events" {
  name           = "${local.name_prefix}-webhook-events"
  description    = "Routes committed platform semantic events to native webhook subscriptions."
  event_bus_name = var.event_bus_name
  event_pattern = jsonencode({
    source = ["deployments-ai.platform"]
  })
  tags = local.common_tags
}

data "aws_iam_policy_document" "webhook_event_failures" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.webhook_event_failures.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.webhook_events.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "webhook_event_failures" {
  queue_url = aws_sqs_queue.webhook_event_failures.id
  policy    = data.aws_iam_policy_document.webhook_event_failures.json
}

resource "aws_cloudwatch_event_target" "webhook_events" {
  arn            = aws_lambda_function.webhook_events.arn
  event_bus_name = var.event_bus_name
  rule           = aws_cloudwatch_event_rule.webhook_events.name
  target_id      = "native-webhook-delivery"

  dead_letter_config {
    arn = aws_sqs_queue.webhook_event_failures.arn
  }

  retry_policy {
    maximum_event_age_in_seconds = 86400
    maximum_retry_attempts       = 185
  }

  depends_on = [aws_sqs_queue_policy.webhook_event_failures]
}

resource "aws_lambda_permission" "webhook_events" {
  statement_id  = "AllowSemanticEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.webhook_events.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.webhook_events.arn
}

resource "aws_lambda_function_event_invoke_config" "webhook_events" {
  function_name                = aws_lambda_function.webhook_events.function_name
  maximum_event_age_in_seconds = 21600
  maximum_retry_attempts       = 2

  destination_config {
    on_failure {
      destination = aws_sqs_queue.webhook_event_failures.arn
    }
  }
}

resource "aws_lambda_event_source_mapping" "webhook_deliveries" {
  event_source_arn        = aws_sqs_queue.webhook_deliveries.arn
  function_name           = aws_lambda_function.webhook_deliveries.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.webhook_delivery_maximum_concurrency
  }

  depends_on = [aws_iam_role_policy.worker]
}

resource "aws_lambda_function" "schedule_fire" {
  function_name = "${local.name_prefix}-schedule-fire"
  role          = aws_iam_role.worker.arn
  handler       = "schedule-fire.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 120
  memory_size   = 1024

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = local.fire_runtime_environment
  }

  vpc_config {
    security_group_ids = [aws_security_group.worker.id]
    subnet_ids         = var.private_subnet_ids
  }

  depends_on = [aws_cloudwatch_log_group.schedule_fire, aws_iam_role_policy.worker]
  tags       = local.common_tags
}

resource "aws_lambda_function" "heartbeat_fire" {
  function_name = "${local.name_prefix}-heartbeat-fire"
  role          = aws_iam_role.worker.arn
  handler       = "heartbeat-fire.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 120
  memory_size   = 1024

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = local.fire_runtime_environment
  }

  vpc_config {
    security_group_ids = [aws_security_group.worker.id]
    subnet_ids         = var.private_subnet_ids
  }

  depends_on = [aws_cloudwatch_log_group.heartbeat_fire, aws_iam_role_policy.worker]
  tags       = local.common_tags
}

resource "aws_lambda_function_event_invoke_config" "automation_fire" {
  for_each = {
    heartbeat = aws_lambda_function.heartbeat_fire.function_name
    schedule  = aws_lambda_function.schedule_fire.function_name
  }

  function_name                = each.value
  maximum_event_age_in_seconds = 21600
  maximum_retry_attempts       = 2

  destination_config {
    on_failure {
      destination = aws_sqs_queue.automation_failures.arn
    }
  }
}
