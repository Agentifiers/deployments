resource "aws_cloudwatch_log_group" "run_dispatch" {
  name              = "/aws/lambda/${local.name_prefix}-run-dispatch"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_sqs_queue" "run_dispatch_failures" {
  name                      = "${local.name_prefix}-run-dispatch-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_iam_role" "run_dispatch" {
  name                 = "${local.iam_name_prefix}-run-dispatch"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "run_dispatch" {
  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${aws_cloudwatch_log_group.run_dispatch.arn}:*",
    ]
  }

  statement {
    sid       = "EnqueueRuns"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.runs.arn, aws_sqs_queue.run_dispatch_failures.arn]
  }
}

resource "aws_iam_role_policy" "run_dispatch" {
  name   = "${local.name_prefix}-run-dispatch"
  role   = aws_iam_role.run_dispatch.id
  policy = data.aws_iam_policy_document.run_dispatch.json
}

resource "aws_lambda_function" "run_dispatch" {
  function_name = "${local.name_prefix}-run-dispatch"
  role          = aws_iam_role.run_dispatch.arn
  handler       = "run-dispatch.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 30
  memory_size   = 512

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = {
      DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL = aws_sqs_queue.runs.url
    }
  }

  depends_on = [aws_cloudwatch_log_group.run_dispatch, aws_iam_role_policy.run_dispatch]
  tags       = local.common_tags
}

resource "aws_cloudwatch_event_rule" "run_requested" {
  name           = "${local.name_prefix}-run-requested"
  description    = "Durably reconcile committed run requests into the agent run queue."
  event_bus_name = var.event_bus_name
  event_pattern = jsonencode({
    source      = ["deployments-ai.platform"]
    detail-type = ["run.requested"]
    detail = {
      eventType = ["run.requested"]
    }
  })
  tags = local.common_tags
}

data "aws_iam_policy_document" "run_dispatch_failures" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.run_dispatch_failures.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.run_requested.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "run_dispatch_failures" {
  queue_url = aws_sqs_queue.run_dispatch_failures.id
  policy    = data.aws_iam_policy_document.run_dispatch_failures.json
}

resource "aws_cloudwatch_event_target" "run_requested" {
  event_bus_name = var.event_bus_name
  rule           = aws_cloudwatch_event_rule.run_requested.name
  target_id      = "run-dispatch"
  arn            = aws_lambda_function.run_dispatch.arn

  dead_letter_config {
    arn = aws_sqs_queue.run_dispatch_failures.arn
  }

  retry_policy {
    maximum_event_age_in_seconds = 86400
    maximum_retry_attempts       = 185
  }

  depends_on = [aws_sqs_queue_policy.run_dispatch_failures]
}

resource "aws_lambda_permission" "run_requested" {
  statement_id  = "AllowRunRequestedEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.run_dispatch.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.run_requested.arn
}

resource "aws_lambda_function_event_invoke_config" "run_dispatch" {
  function_name                = aws_lambda_function.run_dispatch.function_name
  maximum_event_age_in_seconds = 21600
  maximum_retry_attempts       = 2

  destination_config {
    on_failure {
      destination = aws_sqs_queue.run_dispatch_failures.arn
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "run_dispatch_failures" {
  alarm_name          = "${local.name_prefix}-run-dispatch-failures-visible"
  alarm_description   = "Committed run requests exhausted durable queue dispatch retries."
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

  dimensions = {
    QueueName = aws_sqs_queue.run_dispatch_failures.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "run_dispatch_destination_failures" {
  alarm_name          = "${local.name_prefix}-run-dispatch-destination-failures"
  alarm_description   = "Lambda could not retain an exhausted committed run dispatch invocation."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DestinationDeliveryFailures"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    FunctionName = aws_lambda_function.run_dispatch.function_name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
