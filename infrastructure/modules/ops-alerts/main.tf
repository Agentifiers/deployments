locals {
  # Alarms exist only when the topic reaches someone: an alarm nobody receives still costs $0.10 a month.
  connected = var.alert_email != "" || var.slack_channel_id != ""
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
    },
    var.tags,
  )
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

resource "aws_sns_topic" "ops_alerts" {
  name              = "ops-alerts"
  kms_master_key_id = var.kms_key_arn
  tags              = local.common_tags
}

data "aws_iam_policy_document" "ops_alerts" {
  statement {
    sid = "AllowAccountAdministration"

    actions = [
      "sns:AddPermission",
      "sns:DeleteTopic",
      "sns:GetTopicAttributes",
      "sns:ListSubscriptionsByTopic",
      "sns:Publish",
      "sns:RemovePermission",
      "sns:SetTopicAttributes",
      "sns:Subscribe",
    ]
    resources = [aws_sns_topic.ops_alerts.arn]

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowCloudWatchAlarmPublishing"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.ops_alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "ops_alerts" {
  arn    = aws_sns_topic.ops_alerts.arn
  policy = data.aws_iam_policy_document.ops_alerts.json
}

resource "aws_sns_topic_subscription" "alert_email" {
  count = var.alert_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.ops_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_ssm_parameter" "slack_bot_token" {
  name        = "/ops-alerts/slack-bot-token"
  description = "Ops alerts Slack app bot token managed by an operator."
  type        = "SecureString"
  value       = "pending"
  tags        = local.common_tags

  lifecycle {
    ignore_changes = [value]
  }
}
