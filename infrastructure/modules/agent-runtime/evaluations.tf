locals {
  evaluation_lambda_timeout_seconds    = 300
  evaluation_batch_size                = 5
  evaluation_maximum_concurrency       = 5
  evaluation_redrive_max_receive_count = 5
  evaluation_worker_environment = {
    DEPLOYMENTS_AI_ARTIFACT_BUCKET              = var.artifact_bucket_name
    DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON = jsonencode(var.legacy_artifact_bucket_names)
    DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN         = var.data_kms_key_arn
    DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL          = aws_sqs_queue.runs.url
    DEPLOYMENTS_AI_CONTROL_TABLE                = var.dynamodb_table_names["control"]
    DEPLOYMENTS_AI_EVALUATION_QUEUE_URL         = aws_sqs_queue.evaluations.url
    DEPLOYMENTS_AI_EVENTS_TABLE                 = var.dynamodb_table_names["events"]
    DEPLOYMENTS_AI_EXECUTION_TABLE              = var.dynamodb_table_names["execution"]
    DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS   = join(",", var.model_token_service_fallback_models)
    DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL       = var.model_gateway_base_url
    DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER   = aws_lambda_function.model_token_issuer["evaluations"].function_name
    DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN   = var.model_grants_parameter_arn
    DEPLOYMENTS_AI_USAGE_TABLE                  = var.dynamodb_table_names["usage"]
  }
}

resource "aws_sqs_queue" "evaluations_dlq" {
  name                        = "${local.name_prefix}-evaluations-dlq.fifo"
  fifo_queue                  = true
  message_retention_seconds   = 1209600
  sqs_managed_sse_enabled     = true
  content_based_deduplication = false
  tags                        = local.common_tags
}

resource "aws_sqs_queue" "evaluations" {
  name                        = "${local.name_prefix}-evaluations.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  delay_seconds               = 15
  message_retention_seconds   = 1209600
  visibility_timeout_seconds  = local.evaluation_lambda_timeout_seconds * 6
  sqs_managed_sse_enabled     = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.evaluations_dlq.arn
    maxReceiveCount     = local.evaluation_redrive_max_receive_count
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_log_group" "evaluation_worker" {
  name              = "/aws/lambda/${local.name_prefix}-evaluation-worker"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

data "aws_iam_policy_document" "evaluations" {
  statement {
    sid       = "EvaluationLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.evaluation_worker.arn}:*"]
  }

  statement {
    sid = "EvaluationQueue"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
      "sqs:SendMessage",
    ]
    resources = [aws_sqs_queue.evaluations.arn]
  }

  statement {
    sid       = "InvokeEvaluationModelTokenIssuer"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.model_token_issuer["evaluations"].arn]
  }
}

resource "aws_iam_role_policy" "evaluations" {
  name   = "${local.name_prefix}-evaluations"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.evaluations.json
}

resource "aws_lambda_function" "evaluation_worker" {
  function_name = "${local.name_prefix}-evaluation-worker"
  role          = aws_iam_role.worker.arn
  handler       = "evaluation-worker-main.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = local.evaluation_lambda_timeout_seconds
  memory_size   = 1024

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = local.evaluation_worker_environment
  }

  vpc_config {
    security_group_ids = concat([aws_security_group.worker.id], var.worker_additional_security_group_ids)
    subnet_ids         = var.private_subnet_ids
  }

  depends_on = [
    aws_cloudwatch_log_group.evaluation_worker,
    aws_iam_role_policy.evaluations,
    aws_iam_role_policy.worker,
    aws_iam_role_policy_attachment.worker_runtime,
  ]
  tags = local.common_tags
}

resource "aws_lambda_event_source_mapping" "evaluations" {
  event_source_arn        = aws_sqs_queue.evaluations.arn
  function_name           = aws_lambda_function.evaluation_worker.arn
  batch_size              = local.evaluation_batch_size
  enabled                 = true
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = local.evaluation_maximum_concurrency
  }

  depends_on = [aws_iam_role_policy.evaluations]
}

resource "aws_cloudwatch_metric_alarm" "evaluation_dlq" {
  alarm_name          = "${local.name_prefix}-evaluation-dlq-visible"
  alarm_description   = "Evaluation jobs are accumulating in the dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { QueueName = aws_sqs_queue.evaluations_dlq.name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "evaluation_queue_age" {
  alarm_name          = "${local.name_prefix}-evaluation-queue-age"
  alarm_description   = "Evaluation queue latency exceeds fifteen minutes."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  comparison_operator = "GreaterThanThreshold"
  threshold           = 900
  dimensions          = { QueueName = aws_sqs_queue.evaluations.name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "evaluation_worker_errors" {
  alarm_name          = "${local.name_prefix}-evaluation-worker-errors"
  alarm_description   = "Evaluation worker Lambda is returning errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { FunctionName = aws_lambda_function.evaluation_worker.function_name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
