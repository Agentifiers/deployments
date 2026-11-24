# Activates each organization's default Brain search placement once its memory search
# placement is active: the Brain index reuses that placement's embedding profile.
resource "aws_sqs_queue" "search_placement_dlq" {
  name                      = "${local.name_prefix}-search-placement-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}

resource "aws_lambda_function" "search_placement" {
  function_name     = "${local.name_prefix}-search-placement"
  architectures     = ["arm64"]
  handler           = "brain-search-placement-main.handler"
  memory_size       = 512
  role              = aws_iam_role.runtime["brain-search-placement"].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 300
  lifecycle { ignore_changes = [s3_bucket, s3_key, s3_object_version] }
  environment {
    variables = {
      DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT = local.opensearch_endpoint
      DEPLOYMENTS_AI_CONTROL_TABLE             = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_EVENTS_TABLE              = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE           = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_USAGE_TABLE               = var.dynamodb_table_names["usage"]
    }
  }
  vpc_config {
    security_group_ids = [aws_security_group.runtime.id]
    subnet_ids         = var.private_subnet_ids
  }
  depends_on = [aws_cloudwatch_log_group.runtime, aws_iam_role_policy.runtime]
  tags       = local.common_tags
}

resource "aws_cloudwatch_event_rule" "search_placement" {
  name           = "${local.name_prefix}-search-placement"
  event_bus_name = var.event_bus_name
  event_pattern = jsonencode({
    source        = ["deployments-ai.platform"]
    "detail-type" = ["memory.search-placement.activated"]
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "search_placement" {
  event_bus_name = var.event_bus_name
  rule           = aws_cloudwatch_event_rule.search_placement.name
  arn            = aws_lambda_function.search_placement.arn
  target_id      = "brain-search-placement"
  dead_letter_config { arn = aws_sqs_queue.search_placement_dlq.arn }
}

resource "aws_lambda_permission" "search_placement" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.search_placement.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.search_placement.arn
  statement_id  = "AllowBrainSearchPlacementEventBridge"
}

# Asynchronous invocations retry twice; a placement that still fails lands here for redrive.
resource "aws_lambda_function_event_invoke_config" "search_placement" {
  function_name = aws_lambda_function.search_placement.function_name
  destination_config {
    on_failure { destination = aws_sqs_queue.search_placement_dlq.arn }
  }
}

data "aws_iam_policy_document" "search_placement_dlq" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.search_placement_dlq.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.search_placement.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "search_placement_dlq" {
  queue_url = aws_sqs_queue.search_placement_dlq.url
  policy    = data.aws_iam_policy_document.search_placement_dlq.json
}
