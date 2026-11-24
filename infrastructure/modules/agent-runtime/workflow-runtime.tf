locals {
  workflow_event_types = [
    "channel.delivery.failed",
    "channel.delivery.sent",
    "run.canceled",
    "run.completed",
    "run.failed",
    "tool-call.failed",
    "tool-call.completed",
    "workflow-approval.resolved",
    "workflow-approval.requested",
    "workflow-escalation.requested",
    "workflow-execution.advance-requested",
    "workflow-execution.cancel-requested",
    "workflow-execution.requested",
    "workflow-notification.requested",
    "workflow-step.dispatch-requested",
  ]
  workflow_queue_environment = merge(local.agent_worker_environment, {
    DEPLOYMENTS_AI_WORKFLOW_APPROVAL_TIMEOUT_LAMBDA_ARN = aws_lambda_function.workflow_approval_timeout.arn
  })
  workflow_event_router_environment = merge(local.workflow_queue_environment, {
    DEPLOYMENTS_AI_WORKFLOW_QUEUE_URL = aws_sqs_queue.workflow.url
  })
  workflow_queue_environment_base64 = base64encode(jsonencode(local.workflow_queue_environment))
  workflow_queue_environment_size_bytes = floor(
    length(local.workflow_queue_environment_base64) * 3 / 4
  ) - length(regexall("=", local.workflow_queue_environment_base64))
  workflow_event_router_environment_base64 = base64encode(jsonencode(local.workflow_event_router_environment))
  workflow_event_router_environment_size_bytes = floor(
    length(local.workflow_event_router_environment_base64) * 3 / 4
  ) - length(regexall("=", local.workflow_event_router_environment_base64))
}

resource "aws_sqs_queue" "workflow_dlq" {
  name                      = "${local.name_prefix}-workflow-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "workflow" {
  name                        = "${local.name_prefix}-workflow.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  message_retention_seconds   = 1209600
  visibility_timeout_seconds  = local.workflow_queue_visibility_timeout_seconds
  sqs_managed_sse_enabled     = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.workflow_dlq.arn
    maxReceiveCount     = 10
  })
  tags = local.common_tags
}

resource "aws_sqs_queue" "workflow_event_failures" {
  name                      = "${local.name_prefix}-workflow-event-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_cloudwatch_log_group" "workflow_queue" {
  name              = "/aws/lambda/${local.name_prefix}-workflow-queue"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "workflow_event_router" {
  name              = "/aws/lambda/${local.name_prefix}-workflow-event-router"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "workflow_approval_timeout" {
  name              = "/aws/lambda/${local.name_prefix}-workflow-approval-timeout"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_lambda_function" "workflow_approval_timeout" {
  function_name = "${local.name_prefix}-workflow-approval-timeout"
  description   = "Expires a durable workflow approval at its configured deadline."
  role          = aws_iam_role.worker.arn
  handler       = "approval-timeout-main.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 30
  memory_size   = 512

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]

    precondition {
      condition     = local.agent_worker_environment_size_bytes <= 4096
      error_message = "Workflow approval-timeout Lambda environment is ${local.agent_worker_environment_size_bytes} bytes; AWS allows at most 4096 bytes."
    }
  }

  environment {
    variables = local.agent_worker_environment
  }

  vpc_config {
    security_group_ids = [aws_security_group.worker.id]
    subnet_ids         = var.private_subnet_ids
  }

  depends_on = [
    aws_cloudwatch_log_group.workflow_approval_timeout,
    aws_iam_role_policy.worker,
    aws_iam_role_policy_attachment.worker_runtime,
  ]
  tags = local.common_tags
}

resource "aws_lambda_function" "workflow_queue" {
  function_name = "${local.name_prefix}-workflow-queue"
  description   = "Advances durable workflow executions one serialized command at a time."
  role          = aws_iam_role.worker.arn
  handler       = "queue-main.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 900
  memory_size   = 2048

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]

    precondition {
      condition     = local.workflow_queue_environment_size_bytes <= 4096
      error_message = "Workflow queue Lambda environment is ${local.workflow_queue_environment_size_bytes} bytes; AWS allows at most 4096 bytes."
    }
  }

  environment {
    variables = local.workflow_queue_environment
  }

  vpc_config {
    security_group_ids = [aws_security_group.worker.id]
    subnet_ids         = var.private_subnet_ids
  }

  depends_on = [
    aws_cloudwatch_log_group.workflow_queue,
    aws_iam_role_policy.worker,
    aws_iam_role_policy_attachment.worker_runtime,
  ]
  tags = local.common_tags
}

resource "aws_lambda_event_source_mapping" "workflow" {
  event_source_arn        = aws_sqs_queue.workflow.arn
  function_name           = aws_lambda_function.workflow_queue.arn
  batch_size              = 1
  enabled                 = true
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_lambda_function" "workflow_event_router" {
  function_name = "${local.name_prefix}-workflow-event-router"
  description   = "Routes committed workflow and child terminal events into the workflow FIFO queue."
  role          = aws_iam_role.worker.arn
  handler       = "event-router-main.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 30
  memory_size   = 512

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]

    precondition {
      condition     = local.workflow_event_router_environment_size_bytes <= 4096
      error_message = "Workflow event-router Lambda environment is ${local.workflow_event_router_environment_size_bytes} bytes; AWS allows at most 4096 bytes."
    }
  }

  environment {
    variables = local.workflow_event_router_environment
  }

  vpc_config {
    security_group_ids = [aws_security_group.worker.id]
    subnet_ids         = var.private_subnet_ids
  }

  depends_on = [
    aws_cloudwatch_log_group.workflow_event_router,
    aws_iam_role_policy.worker,
    aws_iam_role_policy_attachment.worker_runtime,
  ]
  tags = local.common_tags
}

resource "aws_cloudwatch_event_rule" "workflow_runtime" {
  name           = "${local.name_prefix}-workflow-runtime"
  description    = "Routes committed workflow events and terminal child events into durable execution."
  event_bus_name = var.event_bus_name
  event_pattern = jsonencode({
    source      = ["deployments-ai.platform"]
    detail-type = local.workflow_event_types
    detail = {
      eventType = local.workflow_event_types
    }
  })
  tags = local.common_tags
}

data "aws_iam_policy_document" "workflow_event_failures" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.workflow_event_failures.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.workflow_runtime.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "workflow_event_failures" {
  queue_url = aws_sqs_queue.workflow_event_failures.id
  policy    = data.aws_iam_policy_document.workflow_event_failures.json
}

resource "aws_cloudwatch_event_target" "workflow_runtime" {
  arn            = aws_lambda_function.workflow_event_router.arn
  event_bus_name = var.event_bus_name
  rule           = aws_cloudwatch_event_rule.workflow_runtime.name
  target_id      = "workflow-runtime"

  dead_letter_config {
    arn = aws_sqs_queue.workflow_event_failures.arn
  }

  retry_policy {
    maximum_event_age_in_seconds = 86400
    maximum_retry_attempts       = 185
  }

  depends_on = [aws_sqs_queue_policy.workflow_event_failures]
}

resource "aws_lambda_permission" "workflow_runtime" {
  statement_id  = "AllowWorkflowSemanticEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.workflow_event_router.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.workflow_runtime.arn
}

resource "aws_cloudwatch_metric_alarm" "workflow_dlq" {
  alarm_name          = "${local.name_prefix}-workflow-dlq-visible"
  alarm_description   = "Workflow execution commands are accumulating in the dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { QueueName = aws_sqs_queue.workflow_dlq.name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "workflow_event_failures" {
  alarm_name          = "${local.name_prefix}-workflow-event-failures-visible"
  alarm_description   = "Committed workflow events exhausted EventBridge delivery retries."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { QueueName = aws_sqs_queue.workflow_event_failures.name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "workflow_queue_age" {
  alarm_name          = "${local.name_prefix}-workflow-queue-age"
  alarm_description   = "Workflow execution queue latency exceeds five minutes."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  comparison_operator = "GreaterThanThreshold"
  threshold           = 300
  dimensions          = { QueueName = aws_sqs_queue.workflow.name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "workflow_lambda_errors" {
  for_each = var.alarms_enabled ? {
    approval-timeout = aws_lambda_function.workflow_approval_timeout.function_name
    event-router     = aws_lambda_function.workflow_event_router.function_name
    queue            = aws_lambda_function.workflow_queue.function_name
  } : {}

  alarm_name          = "${local.name_prefix}-workflow-${each.key}-errors"
  alarm_description   = "Workflow ${each.key} Lambda is returning errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { FunctionName = each.value }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags
}
