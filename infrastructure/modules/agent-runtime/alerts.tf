# Monitors and alerts: one function evaluates monitors when platform events arrive and on a
# schedule, and emails alert events through SES. It has its own role so the SES and hot-plane
# grants stay off the shared worker role.

locals {
  alerts_function_name = "${local.name_prefix}-alerts"
  alerts_enabled       = trimspace(var.alert_email.sender) != ""
  # One schedule per monitor sweep shard (MONITOR_SWEEP_SHARD_COUNT in packages/db), so each
  # shard gets its own invocation and timeout instead of one walk across all of them.
  alerts_sweep_shards  = toset([for shard in ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15"] : shard if local.alerts_enabled])
  alerts_hot_plane     = trimspace(var.alert_email.observability_base_url) != ""
  alerts_sender_domain = local.alerts_enabled ? split("@", trimspace(var.alert_email.sender))[1] : ""
  alerts_sender_identities = local.alerts_enabled ? [
    for identity in [local.alerts_sender_domain, trimspace(var.alert_email.sender)] :
    "arn:${data.aws_partition.current.partition}:ses:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:identity/${identity}"
  ] : []
  alerts_environment = merge({
    DEPLOYMENTS_AI_ALERT_CONSOLE_ORIGIN = var.alert_email.console_origin
    DEPLOYMENTS_AI_ALERT_EMAIL_SENDER   = trimspace(var.alert_email.sender)
    DEPLOYMENTS_AI_ALERT_PRODUCT_NAME   = var.alert_email.product_name
    DEPLOYMENTS_AI_CONTROL_TABLE        = var.dynamodb_table_names["control"]
    DEPLOYMENTS_AI_EVENTS_TABLE         = var.dynamodb_table_names["events"]
    DEPLOYMENTS_AI_EXECUTION_TABLE      = var.dynamodb_table_names["execution"]
    DEPLOYMENTS_AI_USAGE_TABLE          = var.dynamodb_table_names["usage"]
    }, local.alerts_hot_plane ? {
    DEPLOYMENTS_AI_OBSERVABILITY_BASE_URL   = var.alert_email.observability_base_url
    DEPLOYMENTS_AI_OBSERVABILITY_SECRET_ARN = var.alert_email.observability_secret_arn
  } : {})
}

resource "aws_cloudwatch_log_group" "alerts" {
  count             = local.alerts_enabled ? 1 : 0
  name              = "/aws/lambda/${local.alerts_function_name}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "alerts" {
  count                = local.alerts_enabled ? 1 : 0
  name                 = "${local.iam_name_prefix}-alerts"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "alerts" {
  count = local.alerts_enabled ? 1 : 0

  statement {
    sid       = "AlertLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.alerts[0].arn}:*"]
  }

  statement {
    sid = "AlertTables"
    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ]
    resources = concat(
      [for name in ["control", "events"] : var.dynamodb_table_arns[name]],
      [for name in ["control", "events"] : "${var.dynamodb_table_arns[name]}/index/*"],
    )
  }

  # The approval-wait monitor reads pending approvals; nothing here writes execution records.
  statement {
    sid       = "AlertExecutionReads"
    actions   = ["dynamodb:GetItem", "dynamodb:Query"]
    resources = [var.dynamodb_table_arns["execution"], "${var.dynamodb_table_arns["execution"]}/index/*"]
  }

  statement {
    sid       = "AlertFailureDestination"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.alert_failures[0].arn]
  }

  statement {
    sid       = "AlertKms"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.data_kms_key_arn]
  }

  statement {
    sid     = "AlertEmail"
    actions = ["ses:SendEmail"]
    # SES authorizes against the address identity when the sender address itself is verified,
    # and against the domain identity otherwise.
    resources = local.alerts_sender_identities

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [trimspace(var.alert_email.sender)]
    }
  }

  dynamic "statement" {
    for_each = local.alerts_hot_plane ? [1] : []
    content {
      sid       = "AlertObservabilityCredential"
      actions   = ["ssm:GetParameter"]
      resources = [var.alert_email.observability_secret_arn]
    }
  }

  dynamic "statement" {
    for_each = local.alerts_hot_plane ? [1] : []
    content {
      sid = "AlertVpcNetworking"
      actions = [
        "ec2:CreateNetworkInterface",
        "ec2:DeleteNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "alerts" {
  count  = local.alerts_enabled ? 1 : 0
  name   = "${local.name_prefix}-alerts"
  role   = aws_iam_role.alerts[0].id
  policy = data.aws_iam_policy_document.alerts[0].json
}

# The private observability hot plane is reachable only inside the VPC, so the function joins it
# when metric monitors have a hot plane to read; otherwise it needs only AWS public endpoints.
resource "aws_lambda_function" "alerts" {
  count         = local.alerts_enabled ? 1 : 0
  function_name = local.alerts_function_name
  description   = "Evaluates monitors on platform events and on a schedule, and emails alerts."
  role          = aws_iam_role.alerts[0].arn
  handler       = "alert-event-handler.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 300
  memory_size   = 512

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]

    precondition {
      condition     = !local.alerts_hot_plane || trimspace(var.alert_email.observability_secret_arn) != ""
      error_message = "alert_email.observability_base_url and observability_secret_arn must be set together."
    }
    precondition {
      condition     = can(regex("^https?://[^/[:space:]]+$", trimspace(var.alert_email.console_origin)))
      error_message = "alert_email.console_origin must be the console origin, such as https://console.example.com."
    }
  }

  environment {
    variables = local.alerts_environment
  }

  dynamic "vpc_config" {
    for_each = local.alerts_hot_plane ? [1] : []
    content {
      security_group_ids = [aws_security_group.worker.id]
      subnet_ids         = var.private_subnet_ids
    }
  }

  depends_on = [aws_cloudwatch_log_group.alerts, aws_iam_role_policy.alerts]
  tags       = local.common_tags
}

resource "aws_sqs_queue" "alert_failures" {
  count                     = local.alerts_enabled ? 1 : 0
  name                      = "${local.name_prefix}-alert-failures"
  max_message_size          = 1048576
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

data "aws_iam_policy_document" "alert_failures" {
  count = local.alerts_enabled ? 1 : 0

  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.alert_failures[0].arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.alerts[0].arn]
    }
  }
}

resource "aws_sqs_queue_policy" "alert_failures" {
  count     = local.alerts_enabled ? 1 : 0
  queue_url = aws_sqs_queue.alert_failures[0].id
  policy    = data.aws_iam_policy_document.alert_failures[0].json
}

# Monitor source events and alert events. The handler ignores anything it does not act on, so
# the pattern only keeps unrelated traffic from invoking it.
resource "aws_cloudwatch_event_rule" "alerts" {
  count          = local.alerts_enabled ? 1 : 0
  name           = "${local.name_prefix}-alerts"
  description    = "Routes monitored platform events and alert events to the alerts function."
  event_bus_name = var.event_bus_name
  event_pattern = jsonencode({
    source = ["deployments-ai.platform"]
    "detail-type" = [
      "alert.fired",
      "alert.renotified",
      "alert.resolved",
      "alert.test",
      "approval.requested",
      "approval.resolved",
      "budget.threshold-crossed",
      "organization.operator-funded-spend-exhausted",
      "run.failed",
      "schedule.expired",
      "schedule.skipped",
      "tool-call.failed",
      "webhook.endpoint.archived",
      "webhook.endpoint.disabled",
      "webhook.endpoint.enabled",
      "webhook.endpoint.updated",
    ]
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "alerts" {
  count          = local.alerts_enabled ? 1 : 0
  arn            = aws_lambda_function.alerts[0].arn
  event_bus_name = var.event_bus_name
  rule           = aws_cloudwatch_event_rule.alerts[0].name
  target_id      = "monitor-alerts"

  dead_letter_config {
    arn = aws_sqs_queue.alert_failures[0].arn
  }

  retry_policy {
    maximum_event_age_in_seconds = 21600
    maximum_retry_attempts       = 50
  }

  depends_on = [aws_sqs_queue_policy.alert_failures]
}

resource "aws_lambda_permission" "alerts_events" {
  count         = local.alerts_enabled ? 1 : 0
  statement_id  = "AllowSemanticEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.alerts[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.alerts[0].arn
}

resource "aws_lambda_function_event_invoke_config" "alerts" {
  count                        = local.alerts_enabled ? 1 : 0
  function_name                = aws_lambda_function.alerts[0].function_name
  maximum_event_age_in_seconds = 21600
  maximum_retry_attempts       = 2

  destination_config {
    on_failure {
      destination = aws_sqs_queue.alert_failures[0].arn
    }
  }
}

# Windowed counts resolve, one-shot incidents expire, and current-state and metric monitors are
# observed on this cadence; evaluation is idempotent, so an overlapping sweep changes nothing.
# A rule takes at most five targets, so each shard has its own rule.
resource "aws_cloudwatch_event_rule" "alerts_sweep" {
  for_each            = local.alerts_sweep_shards
  name                = "${local.name_prefix}-alerts-sweep-${each.key}"
  description         = "Evaluates every live monitor in sweep shard ${each.key}."
  schedule_expression = "rate(5 minutes)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "alerts_sweep" {
  for_each = local.alerts_sweep_shards
  arn      = aws_lambda_function.alerts[0].arn
  input    = jsonencode({ sweep = true, shard = tonumber(each.key) })
  rule     = aws_cloudwatch_event_rule.alerts_sweep[each.key].name
}

resource "aws_lambda_permission" "alerts_sweep" {
  for_each      = local.alerts_sweep_shards
  statement_id  = "AllowAlertSweepSchedule${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.alerts[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.alerts_sweep[each.key].arn
}

# The sweep logs a monitor it cannot evaluate and goes on, so its failures arrive as the
# MonitorEvaluationFailures embedded metric rather than as Lambda errors; both count here.
resource "aws_cloudwatch_metric_alarm" "alerts_errors" {
  count               = var.alarms_enabled && local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-alerts-errors"
  alarm_description   = "The alerts function is failing or monitors keep failing to evaluate: monitors may not evaluate or alert emails may not send."
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  metric_query {
    id          = "failures"
    expression  = "FILL(errors, 0) + FILL(evaluations, 0)"
    label       = "Alert function errors and failed monitor evaluations"
    return_data = true
  }

  metric_query {
    id = "errors"
    metric {
      namespace   = "AWS/Lambda"
      metric_name = "Errors"
      period      = 300
      stat        = "Sum"
      dimensions  = { FunctionName = aws_lambda_function.alerts[0].function_name }
    }
  }

  metric_query {
    id = "evaluations"
    metric {
      namespace   = "DeploymentsAI/Alerts"
      metric_name = "MonitorEvaluationFailures"
      period      = 300
      stat        = "Sum"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "alert_failures_visible" {
  count               = var.alarms_enabled && local.alerts_enabled ? 1 : 0
  alarm_name          = "${local.name_prefix}-alert-failures-visible"
  alarm_description   = "Alert events or evaluations exhausted their retries."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { QueueName = aws_sqs_queue.alert_failures[0].name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags
}
