locals {
  name       = "channel-command"
  flush_name = "channel-ingress-flush"
  common_tags = merge({
    Environment = var.environment
    ManagedBy   = "terraform"
    Product     = "deployments-ai-platform"
  }, var.tags)
  runtime_environment = {
    DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL                 = var.agent_run_queue_url
    DEPLOYMENTS_AI_ARTIFACT_BUCKET                     = var.platform_artifact_bucket_name
    DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN                = var.data_kms_key_arn
    DEPLOYMENTS_AI_CHANNEL_INGRESS_FLUSH_QUEUE_URL     = aws_sqs_queue.flush.url
    DEPLOYMENTS_AI_CONTROL_TABLE                       = var.control_table_name
    DEPLOYMENTS_AI_END_USER_SUBJECT_KEY_ARN            = var.end_user_subject_key_arn
    DEPLOYMENTS_AI_EVENTS_TABLE                        = var.events_table_name
    DEPLOYMENTS_AI_EXECUTION_TABLE                     = var.execution_table_name
    DEPLOYMENTS_AI_INGRESS_ATTACHMENT_CAPTURE_ROLE_ARN = var.ingress_attachment_capture_role_arn
    DEPLOYMENTS_AI_USAGE_TABLE                         = var.usage_table_name
  }
}

resource "aws_sqs_queue" "flush_dlq" {
  name                      = "${local.flush_name}-dlq"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
  tags                      = local.common_tags
}

resource "aws_sqs_queue" "flush" {
  name                       = local.flush_name
  sqs_managed_sse_enabled    = true
  message_retention_seconds  = 345600
  visibility_timeout_seconds = 600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.flush_dlq.arn
    maxReceiveCount     = 5
  })
  tags = local.common_tags
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "runtime" {
  name                 = local.name
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "runtime" {
  statement {
    sid = "ConsumeChannelIngress"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]
    resources = [var.channel_ingress_queue_arn, aws_sqs_queue.flush.arn]
  }

  statement {
    sid       = "ScheduleChannelIngressFlush"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.flush.arn]
  }

  statement {
    sid       = "EnqueueAgentRuns"
    actions   = ["sqs:SendMessage"]
    resources = [var.agent_run_queue_arn]
  }

  statement {
    sid = "ComposeCanonicalRuns"
    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:TransactWriteItems",
    ]
    resources = [
      var.control_table_arn,
      var.events_table_arn,
      var.execution_table_arn,
    ]
  }

  # Run admission refuses new runs once an active budget's current-period spend is exhausted.
  statement {
    sid     = "ReadSpendBudgets"
    actions = ["dynamodb:Query"]
    resources = [
      var.usage_table_arn,
      "${var.usage_table_arn}/index/*",
    ]
  }

  statement {
    sid       = "ReadEndUserSubjectKey"
    actions   = ["ssm:GetParameter"]
    resources = [var.end_user_subject_key_arn]
  }

  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${aws_cloudwatch_log_group.runtime.arn}:*",
      "${aws_cloudwatch_log_group.flush.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "runtime" {
  name   = "runtime"
  role   = aws_iam_role.runtime.id
  policy = data.aws_iam_policy_document.runtime.json
}

resource "aws_iam_role" "flush" {
  name                 = local.flush_name
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

resource "aws_iam_role_policy" "flush_runtime" {
  name   = "runtime"
  role   = aws_iam_role.flush.id
  policy = data.aws_iam_policy_document.runtime.json
}

data "aws_iam_policy_document" "flush_attachments" {
  statement {
    sid       = "AssumeCredentialVaultReader"
    actions   = ["sts:AssumeRole", "sts:TagSession"]
    resources = [var.credential_vault_reader_role_arn]
  }

  statement {
    sid       = "AssumeIngressAttachmentCapture"
    actions   = ["sts:AssumeRole", "sts:TagSession"]
    resources = [var.ingress_attachment_capture_role_arn]
  }

  statement {
    sid       = "InvokeDocumentExtraction"
    actions   = ["lambda:InvokeFunction"]
    resources = [var.document_extraction_function.arn]
  }
}

resource "aws_iam_role_policy" "flush_attachments" {
  name   = "attachments"
  role   = aws_iam_role.flush.id
  policy = data.aws_iam_policy_document.flush_attachments.json
}

resource "aws_cloudwatch_log_group" "runtime" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "flush" {
  name              = "/aws/lambda/${local.flush_name}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_lambda_function" "runtime" {
  function_name     = local.name
  architectures     = ["arm64"]
  handler           = "ingress-consumer-main.handler"
  memory_size       = 512
  role              = aws_iam_role.runtime.arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 60

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = local.runtime_environment
  }
  tags       = local.common_tags
  depends_on = [aws_cloudwatch_log_group.runtime, aws_iam_role_policy.runtime]
}

resource "aws_lambda_function" "flush" {
  function_name     = local.flush_name
  architectures     = ["arm64"]
  handler           = "ingress-consumer-main.handler"
  memory_size       = 512
  role              = aws_iam_role.flush.arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 90

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = merge(local.runtime_environment, {
      DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN            = var.data_kms_key_arn
      DEPLOYMENTS_AI_CREDENTIAL_VAULT_READER_ROLE_ARN  = var.credential_vault_reader_role_arn
      DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME = var.document_extraction_function.function_name
    })
  }
  tags = local.common_tags
  depends_on = [
    aws_cloudwatch_log_group.flush,
    aws_iam_role_policy.flush_attachments,
    aws_iam_role_policy.flush_runtime,
  ]
}

resource "aws_lambda_event_source_mapping" "runtime" {
  event_source_arn        = var.channel_ingress_queue_arn
  function_name           = aws_lambda_function.runtime.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_lambda_event_source_mapping" "flush" {
  event_source_arn = aws_sqs_queue.flush.arn
  function_name    = aws_lambda_function.flush.arn
  batch_size       = 1
  # No batching window: on low-traffic SQS queues any window makes Lambda wait up to 20 s (AWS docs).
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${local.name}-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions          = { FunctionName = aws_lambda_function.runtime.function_name }
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "flush_errors" {
  alarm_name          = "${local.flush_name}-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions          = { FunctionName = aws_lambda_function.flush.function_name }
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "flush_dlq_depth" {
  alarm_name          = "${local.flush_name}-dlq-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  dimensions          = { QueueName = aws_sqs_queue.flush_dlq.name }
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
