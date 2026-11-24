locals {
  # One handler deployed per caller class; behaviour comes only from the environment. Invokers
  # grant themselves lambda:InvokeFunction on their issuer: run (agent worker task role),
  # agent-worker (agent worker task role and agent-runtime Lambda role), evaluations
  # (agent-runtime Lambda role), memory (memory runtime roles), brain (Brain index worker and
  # platform API roles), web-tools (Web Tools task role). Service chat calls without explicit
  # fallbacks request the gateway client's default fallbacks, so those issuers admit them too.
  model_token_issuers = {
    run = {
      kind           = "run"
      service_models = []
      tenant_models  = false
    }
    agent-worker = {
      kind           = "service"
      service_models = concat(var.model_token_service_models.agent_worker, var.model_token_service_fallback_models)
      tenant_models  = false
    }
    evaluations = {
      kind           = "service"
      service_models = var.model_token_service_fallback_models
      tenant_models  = true
    }
    memory = {
      kind           = "service"
      service_models = concat(var.model_token_service_models.memory, var.model_token_service_fallback_models)
      tenant_models  = true
    }
    brain = {
      kind           = "service"
      service_models = concat(var.model_token_service_models.brain, var.model_token_service_fallback_models)
      tenant_models  = false
    }
    web-tools = {
      kind           = "service"
      service_models = var.model_token_service_models.web_tools
      tenant_models  = false
    }
  }
}

resource "aws_cloudwatch_log_group" "model_token_issuer" {
  for_each = local.model_token_issuers

  name              = "/aws/lambda/${local.name_prefix}-model-token-${each.key}"
  retention_in_days = var.log_retention_in_days
  tags              = local.common_tags
}

resource "aws_iam_role" "model_token_issuer" {
  for_each = local.model_token_issuers

  name                 = "${local.iam_name_prefix}-model-token-${each.key}"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

# Issuer roles are the only principals allowed to sign model gateway tokens.
data "aws_iam_policy_document" "model_token_issuer" {
  for_each = local.model_token_issuers

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.model_token_issuer[each.key].arn}:*"]
  }

  statement {
    sid       = "SignModelGatewayTokens"
    actions   = ["kms:Sign"]
    resources = [var.model_gateway_token_signing_key_arn]
  }

  statement {
    sid     = "ReadAdmissionRecords"
    actions = ["dynamodb:BatchGetItem", "dynamodb:GetItem", "dynamodb:Query"]
    resources = flatten([
      for table in ["control", "execution"] : [
        var.dynamodb_table_arns[table],
        "${var.dynamodb_table_arns[table]}/index/*",
      ]
    ])
  }

  # Month-to-date operator-funded spend, read against the organization's model spend ceiling.
  statement {
    sid       = "ReadOrganizationSpend"
    actions   = ["dynamodb:Query"]
    resources = [var.dynamodb_table_arns["usage"]]
  }

  statement {
    sid       = "ReadModelGrants"
    actions   = ["ssm:GetParameter"]
    resources = [var.model_grants_parameter_arn]
  }
}

resource "aws_iam_role_policy" "model_token_issuer" {
  for_each = local.model_token_issuers

  name   = "${local.name_prefix}-model-token-${each.key}"
  role   = aws_iam_role.model_token_issuer[each.key].id
  policy = data.aws_iam_policy_document.model_token_issuer[each.key].json
}

resource "aws_lambda_function" "model_token_issuer" {
  for_each = local.model_token_issuers

  function_name = "${local.name_prefix}-model-token-${each.key}"
  description   = "Mints ${each.key} model gateway tokens."
  role          = aws_iam_role.model_token_issuer[each.key].arn
  handler       = "model-token-issuer-main.handler"
  runtime       = "nodejs26.x"
  architectures = ["arm64"]
  timeout       = 15
  memory_size   = 512

  s3_bucket         = var.lambda_artifact_bucket
  s3_key            = var.lambda_artifact_key
  s3_object_version = var.lambda_artifact_version

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = merge({
      DEPLOYMENTS_AI_CONTROL_TABLE                = var.dynamodb_table_names["control"]
      DEPLOYMENTS_AI_EVENTS_TABLE                 = var.dynamodb_table_names["events"]
      DEPLOYMENTS_AI_EXECUTION_TABLE              = var.dynamodb_table_names["execution"]
      DEPLOYMENTS_AI_MODEL_CREDENTIAL_PROVIDERS   = join(",", var.model_credential_providers)
      DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN   = var.model_grants_parameter_arn
      DEPLOYMENTS_AI_MODEL_TOKEN_EMBEDDING_MODELS = join(",", distinct(var.model_token_embedding_models))
      DEPLOYMENTS_AI_MODEL_TOKEN_ISSUER_KIND      = each.value.kind
      DEPLOYMENTS_AI_MODEL_TOKEN_SIGNING_KEY_ARN  = var.model_gateway_token_signing_key_arn
      DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS        = var.tenant_limit_defaults_json
      DEPLOYMENTS_AI_USAGE_TABLE                  = var.dynamodb_table_names["usage"]
      }, var.default_model_spend_ceiling_usd_micros == null ? {} : {
      DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS = tostring(var.default_model_spend_ceiling_usd_micros)
      }, each.value.kind == "service" ? {
      DEPLOYMENTS_AI_MODEL_TOKEN_SERVICE        = each.key
      DEPLOYMENTS_AI_MODEL_TOKEN_SERVICE_MODELS = join(",", distinct(each.value.service_models))
      DEPLOYMENTS_AI_MODEL_TOKEN_TENANT_MODELS  = tostring(each.value.tenant_models)
    } : {})
  }

  depends_on = [aws_cloudwatch_log_group.model_token_issuer, aws_iam_role_policy.model_token_issuer]
  tags       = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "model_token_issuer_errors" {
  for_each = var.alarms_enabled ? aws_lambda_function.model_token_issuer : {}

  alarm_name          = "${local.name_prefix}-model-token-${each.key}-errors"
  alarm_description   = "The ${each.key} model token issuer Lambda is returning errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  dimensions          = { FunctionName = each.value.function_name }
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
  treat_missing_data  = "notBreaching"
  tags                = local.common_tags
}
