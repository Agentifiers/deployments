locals {
  alert_email = trimspace(var.alert_email)
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Product     = var.product_name
      Purpose     = "billing-alerts"
    },
    var.tags,
  )
  create_alert_key = var.kms_key == null
  alert_key_arn    = local.create_alert_key ? one(aws_kms_key.alerts[*].arn) : var.kms_key.arn
}

data "aws_iam_policy_document" "alert_key" {
  count = local.create_alert_key ? 1 : 0

  statement {
    sid = "AllowAccountAdministration"

    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }

  statement {
    sid = "AllowCostAnomalyDetection"

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["costalerts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_kms_key" "alerts" {
  count = local.create_alert_key ? 1 : 0

  description             = "Encrypts ${var.environment} billing anomaly notifications"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.alert_key[0].json
  tags                    = local.common_tags
}

resource "aws_kms_alias" "alerts" {
  count = local.create_alert_key ? 1 : 0

  name          = "alias/${var.name_prefix}-alerts"
  target_key_id = aws_kms_key.alerts[0].key_id
}

moved {
  from = aws_kms_key.alerts
  to   = aws_kms_key.alerts[0]
}

moved {
  from = aws_kms_alias.alerts
  to   = aws_kms_alias.alerts[0]
}

resource "aws_sns_topic" "immediate_anomalies" {
  name              = "${var.name_prefix}-immediate-anomalies"
  kms_master_key_id = local.alert_key_arn
  tags              = local.common_tags
}

data "aws_iam_policy_document" "immediate_anomalies" {
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
    resources = [aws_sns_topic.immediate_anomalies.arn]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }

  statement {
    sid = "AllowCostAnomalyDetectionPublishing"

    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.immediate_anomalies.arn]

    principals {
      type        = "Service"
      identifiers = ["costalerts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "immediate_anomalies" {
  arn    = aws_sns_topic.immediate_anomalies.arn
  policy = data.aws_iam_policy_document.immediate_anomalies.json
}

resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.immediate_anomalies.arn
  protocol  = "email"
  endpoint  = local.alert_email
}

resource "aws_ce_anomaly_monitor" "services" {
  name              = "${var.name_prefix}-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
  tags              = local.common_tags
}

resource "aws_ce_anomaly_subscription" "immediate" {
  name             = "${var.name_prefix}-immediate"
  frequency        = "IMMEDIATE"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]
  tags             = local.common_tags

  subscriber {
    type    = "SNS"
    address = aws_sns_topic.immediate_anomalies.arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.anomaly_threshold_usd)]
    }
  }

  depends_on = [aws_sns_topic_policy.immediate_anomalies]
}

resource "aws_ce_anomaly_subscription" "daily_summary" {
  name             = "${var.name_prefix}-daily-summary"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]
  tags             = local.common_tags

  subscriber {
    type    = "EMAIL"
    address = local.alert_email
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.anomaly_threshold_usd)]
    }
  }
}

resource "aws_budgets_budget" "daily" {
  name         = "${var.name_prefix}-daily"
  budget_type  = "COST"
  limit_amount = tostring(var.daily_budget_usd)
  limit_unit   = "USD"
  time_unit    = "DAILY"
  tags         = local.common_tags

  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [local.alert_email]
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [local.alert_email]
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
  }
}

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name_prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  tags         = local.common_tags

  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [local.alert_email]
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [local.alert_email]
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [local.alert_email]
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
  }
}
