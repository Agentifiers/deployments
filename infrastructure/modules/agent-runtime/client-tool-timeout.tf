locals {
  client_tool_timeout_function_name = "${local.name_prefix}-client-tool-timeout"
  # Built from the name so the worker environment can reference the target without a cycle.
  client_tool_timeout_function_arn = "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${local.client_tool_timeout_function_name}"
}

resource "aws_cloudwatch_log_group" "client_tool_timeout" {
  name              = "/aws/lambda/${local.client_tool_timeout_function_name}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_lambda_function" "client_tool_timeout" {
  function_name = local.client_tool_timeout_function_name
  description   = "Fails an expired client-executed tool call and resumes its run."
  role          = aws_iam_role.worker.arn
  handler       = "client-tool-timeout-main.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 60
  memory_size   = 512

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]

    precondition {
      condition     = local.agent_worker_environment_size_bytes <= 4096
      error_message = "Client tool timeout Lambda environment is ${local.agent_worker_environment_size_bytes} bytes; AWS allows at most 4096 bytes."
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
    aws_cloudwatch_log_group.client_tool_timeout,
    aws_iam_role_policy.worker,
    aws_iam_role_policy_attachment.worker_runtime,
  ]
  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "client_tool_timeout_errors" {
  alarm_name          = "${local.name_prefix}-client-tool-timeout-errors"
  alarm_description   = "Client tool timeout Lambda is returning errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { FunctionName = aws_lambda_function.client_tool_timeout.function_name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
