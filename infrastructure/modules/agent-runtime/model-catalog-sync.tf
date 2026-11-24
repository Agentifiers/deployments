resource "aws_cloudwatch_log_group" "model_catalog_sync" {
  name              = "/aws/lambda/${local.name_prefix}-model-catalog-sync"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

data "aws_iam_policy_document" "model_catalog_sync" {
  statement {
    sid       = "ModelCatalogSyncLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.model_catalog_sync.arn}:*"]
  }

  dynamic "statement" {
    for_each = var.model_catalog_openai_api_key_secret_arn == "" ? [] : [var.model_catalog_openai_api_key_secret_arn]
    content {
      sid       = "ModelCatalogOpenAiKey"
      actions   = ["ssm:GetParameter"]
      resources = [statement.value]
    }
  }

  # The Service Authorization Reference lists no resource types for these Bedrock control-plane
  # reads, so they only accept "*"; the requested-region condition confines them to the deployment.
  dynamic "statement" {
    for_each = var.model_catalog_bedrock_region == "" ? [] : [var.model_catalog_bedrock_region]
    content {
      sid = "ModelCatalogBedrockModels"
      actions = [
        "bedrock:GetFoundationModelAvailability",
        "bedrock:ListFoundationModels",
        "bedrock:ListInferenceProfiles",
      ]
      resources = ["*"]

      condition {
        test     = "StringEquals"
        variable = "aws:RequestedRegion"
        values   = [statement.value]
      }
    }
  }
}

resource "aws_iam_role_policy" "model_catalog_sync" {
  name   = "${local.name_prefix}-model-catalog-sync"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.model_catalog_sync.json
}

# Runs outside the VPC like the other stream/maintenance functions: it only needs DynamoDB, SSM,
# the regional Bedrock control plane, and public HTTPS egress to openrouter.ai, api.openai.com,
# and getbifrost.ai (the gateway's Bedrock pricing and context-window datasheet).
resource "aws_lambda_function" "model_catalog_sync" {
  function_name = "${local.name_prefix}-model-catalog-sync"
  role          = aws_iam_role.worker.arn
  handler       = "model-catalog-sync-main.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 300
  memory_size   = 512

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = merge({
      DEPLOYMENTS_AI_CONTROL_TABLE   = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_EVENTS_TABLE    = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_USAGE_TABLE     = var.dynamodb_table_names["usage"]
      }, var.model_catalog_openai_api_key_secret_arn == "" ? {} : {
      DEPLOYMENTS_AI_OPENAI_API_KEY_SECRET_ARN = var.model_catalog_openai_api_key_secret_arn
      }, length(var.model_catalog_openai_model_ids) == 0 ? {} : {
      DEPLOYMENTS_AI_OPENAI_MODEL_IDS = join(",", var.model_catalog_openai_model_ids)
      }, var.model_catalog_bedrock_region == "" ? {} : {
      DEPLOYMENTS_AI_BEDROCK_REGION = var.model_catalog_bedrock_region
    })
  }

  depends_on = [
    aws_cloudwatch_log_group.model_catalog_sync,
    aws_iam_role_policy.model_catalog_sync,
    aws_iam_role_policy.worker,
  ]
  tags = local.common_tags
}

resource "aws_cloudwatch_event_rule" "model_catalog_sync" {
  name                = "${local.name_prefix}-model-catalog-sync"
  description         = "Synchronizes the hosted model catalogs from OpenRouter, OpenAI, and Amazon Bedrock."
  schedule_expression = "rate(6 hours)"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "model_catalog_sync" {
  arn  = aws_lambda_function.model_catalog_sync.arn
  rule = aws_cloudwatch_event_rule.model_catalog_sync.name
}

resource "aws_lambda_permission" "model_catalog_sync" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.model_catalog_sync.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.model_catalog_sync.arn
  statement_id  = "AllowModelCatalogSyncSchedule"
}

# A partial or failed provider snapshot throws; a failing scheduled sync leaves the catalog stale.
resource "aws_cloudwatch_metric_alarm" "model_catalog_sync_errors" {
  alarm_name          = "${local.name_prefix}-model-catalog-sync-errors"
  alarm_description   = "Model catalog synchronization Lambda is returning errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { FunctionName = aws_lambda_function.model_catalog_sync.function_name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags

  lifecycle {
    enabled = var.alarms_enabled
  }
}
