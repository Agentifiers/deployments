data "aws_iam_policy_document" "notifier_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_group" "notifier" {
  name              = "/aws/lambda/ops-alerts-notifier"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_sqs_queue" "notifier_failures" {
  name                      = "ops-alerts-notifier-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_iam_role" "notifier" {
  name                 = "ops-alerts-notifier"
  assume_role_policy   = data.aws_iam_policy_document.notifier_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "notifier" {
  statement {
    sid       = "WriteNotifierLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.notifier.arn}:*"]
  }

  statement {
    sid       = "ReadSlackBotToken"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.slack_bot_token.arn]
  }

  statement {
    sid       = "RetainExhaustedNotifications"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.notifier_failures.arn]
  }
}

resource "aws_iam_role_policy" "notifier" {
  name   = "ops-alerts-notifier"
  role   = aws_iam_role.notifier.id
  policy = data.aws_iam_policy_document.notifier.json
}

resource "aws_lambda_function" "notifier" {
  function_name     = "ops-alerts-notifier"
  description       = "Posts CloudWatch alarm notifications from the ops alerts topic to Slack."
  architectures     = ["arm64"]
  handler           = "index.handler"
  memory_size       = 256
  role              = aws_iam_role.notifier.arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.notifier_artifact_bucket
  s3_key            = var.notifier_artifact_key
  s3_object_version = var.notifier_artifact_version
  timeout           = 30

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = {
      OPS_ALERTS_ENVIRONMENT                   = var.environment
      OPS_ALERTS_SLACK_CHANNEL_ID              = var.slack_channel_id
      OPS_ALERTS_SLACK_BOT_TOKEN_PARAMETER_ARN = aws_ssm_parameter.slack_bot_token.arn
    }
  }

  tags = local.common_tags

  depends_on = [
    aws_cloudwatch_log_group.notifier,
    aws_iam_role_policy.notifier,
  ]
}

resource "aws_lambda_function_event_invoke_config" "notifier" {
  function_name          = aws_lambda_function.notifier.function_name
  maximum_retry_attempts = 2

  destination_config {
    on_failure {
      destination = aws_sqs_queue.notifier_failures.arn
    }
  }
}

resource "aws_lambda_permission" "ops_alerts_topic" {
  statement_id  = "AllowOpsAlertsTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notifier.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.ops_alerts.arn
}

resource "aws_sns_topic_subscription" "notifier" {
  topic_arn = aws_sns_topic.ops_alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.notifier.arn

  depends_on = [aws_lambda_permission.ops_alerts_topic]
}
