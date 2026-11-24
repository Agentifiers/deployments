data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

locals {
  system_operator_parameter_arns = [
    for arn in values(var.system_model_provider_secret_arns) : arn if startswith(arn, "arn:aws:ssm:")
  ]
  system_operator_secret_arns = [
    for arn in values(var.system_model_provider_secret_arns) : arn if startswith(arn, "arn:aws:secretsmanager:")
  ]
}

# A parameter rather than an API environment variable: the API environment shares AWS's 4 KiB
# limit. Lambda function names come from the installation record the deploy tool writes instead.
resource "aws_ssm_parameter" "system_operator" {
  name        = "/${local.name_prefix}/system-operator-configuration"
  description = "OpenTofu-owned identifiers the operator /v1/system/* routes read."
  type        = "SecureString"
  tier        = "Intelligent-Tiering"
  value = jsonencode({
    alarmNamePrefix = var.system_alarm_name_prefix
    bedrockRegion   = var.system_bedrock_region
    ecsServices = [
      for service in var.system_ecs_services : [
        service.component,
        element(split("/", service.cluster_arn), 1),
        service.service_name,
      ]
    ]
    modelProviderSecrets = var.system_model_provider_secret_arns
    observability = var.system_observability == null ? null : {
      athenaWorkgroup      = var.system_observability.athena_workgroup
      historyRetentionDays = var.system_observability.history_retention_days
      tableBucket          = var.system_observability.table_bucket
      tableNamespace       = var.system_observability.table_namespace
    }
  })
  tags = local.common_tags
}

# Metadata-only reads for the operator `/v1/system/*` routes. No statement grants
# ssm:GetParameter*, secretsmanager:GetSecretValue, or lambda:GetFunction (code download URL).
data "aws_iam_policy_document" "system_operator" {
  dynamic "statement" {
    for_each = length(var.system_ecs_services) == 0 ? [] : [1]
    content {
      sid     = "DescribeInstallServices"
      actions = ["ecs:DescribeServices"]
      resources = [
        for service in var.system_ecs_services :
        "${replace(service.cluster_arn, ":cluster/", ":service/")}/${service.service_name}"
      ]
    }
  }

  # One paged list instead of a read per released function: Lambda's control-plane reads share a
  # fixed per-account rate with deploys. ListFunctions supports no resource scoping.
  statement {
    sid       = "ListFunctions"
    actions   = ["lambda:ListFunctions"]
    resources = ["*"]
  }

  statement {
    sid       = "DescribeInstallAlarms"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["arn:aws:cloudwatch:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:alarm:${var.system_alarm_name_prefix}*"]
  }

  dynamic "statement" {
    # ssm:DescribeParameters supports no resource-level scoping and returns metadata only.
    for_each = length(local.system_operator_parameter_arns) == 0 ? [] : [1]
    content {
      sid       = "DescribeModelProviderParameters"
      actions   = ["ssm:DescribeParameters"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = length(local.system_operator_secret_arns) == 0 ? [] : [1]
    content {
      sid       = "DescribeModelProviderSecrets"
      actions   = ["secretsmanager:DescribeSecret"]
      resources = local.system_operator_secret_arns
    }
  }
}

# A managed policy keeps these statements outside the role's 10 KiB inline-policy budget.
resource "aws_iam_policy" "system_operator" {
  name   = "${local.name_prefix}-system-operator"
  policy = data.aws_iam_policy_document.system_operator.json
  tags   = local.common_tags
}

resource "aws_iam_role_policy_attachment" "system_operator" {
  role       = aws_iam_role.lambda.name
  policy_arn = aws_iam_policy.system_operator.arn
}
