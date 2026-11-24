resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = var.alarms_enabled ? aws_lambda_function.api : {}

  alarm_name          = "${each.value.function_name}-lambda-errors"
  alarm_description   = "The ${each.key} platform API Lambda is returning errors."
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

  dimensions = {
    FunctionName = each.value.function_name
  }

  tags = local.common_tags
}

moved {
  from = aws_cloudwatch_metric_alarm.lambda_errors
  to   = aws_cloudwatch_metric_alarm.lambda_errors["tenancy"]
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  for_each = var.alarms_enabled ? aws_lambda_function.api : {}

  alarm_name          = "${each.value.function_name}-lambda-throttles"
  alarm_description   = "The ${each.key} platform API Lambda is throttling requests."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    FunctionName = each.value.function_name
  }

  tags = local.common_tags
}

moved {
  from = aws_cloudwatch_metric_alarm.lambda_throttles
  to   = aws_cloudwatch_metric_alarm.lambda_throttles["tenancy"]
}

resource "aws_cloudwatch_metric_alarm" "governance_worker_errors" {
  alarm_name          = "governance-worker-errors"
  alarm_description   = "The governance worker is failing exports, erasures, or retention sweeps."
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

  dimensions = {
    FunctionName = aws_lambda_function.governance_worker.function_name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "governance_operation_failures" {
  alarm_name          = "governance-operation-failures"
  alarm_description   = "A queued governance export, erasure, or tenant retention job failed."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "OperationFailures"
  namespace           = "DeploymentsAI/Governance"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    FunctionName = aws_lambda_function.governance_worker.function_name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "governance_dlq_messages" {
  alarm_name          = "governance-dlq-messages"
  alarm_description   = "Governance operations exhausted retries and reached the dead-letter queue."
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
    QueueName = aws_sqs_queue.governance_dlq.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name_prefix}-5xx"
  alarm_description   = "The unified public product API is returning server errors."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "5xx"
  namespace           = "AWS/ApiGateway"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    ApiId = aws_apigatewayv2_api.public.id
    Stage = aws_apigatewayv2_stage.public.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

resource "aws_cloudwatch_metric_alarm" "api_p99_latency" {
  alarm_name          = "${local.name_prefix}-p99-latency"
  alarm_description   = "The unified public product API p99 latency has exceeded 10 seconds for 15 minutes."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "Latency"
  namespace           = "AWS/ApiGateway"
  period              = 300
  extended_statistic  = "p99"
  threshold           = 10000
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]

  dimensions = {
    ApiId = aws_apigatewayv2_api.public.id
    Stage = aws_apigatewayv2_stage.public.name
  }

  tags = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}

# A single admission that misses the 150 ms budget is the designed fail-open, not an outage:
# on warm functions about 0.2% of checks do, while DynamoDB answers in under 30 ms. An
# unavailable table fails every check, so five in one period separates the two.
resource "aws_cloudwatch_metric_alarm" "tenant_limiter_unavailable" {
  alarm_name          = "tenant-limiter-unavailable"
  alarm_description   = "Organization request rate limiting is failing open because the request admission table is unavailable."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "LimiterUnavailable"
  namespace           = "DeploymentsAi/TenantLimits"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
