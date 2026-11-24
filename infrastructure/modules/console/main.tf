data "aws_caller_identity" "current" {}

locals {
  name        = "console"
  domain_name = trimprefix(var.application_origin, "https://")
  # Leading keys of the identity-table partitions the web BFF owns. Principal and every other
  # identity partition stay unreachable from the console role.
  bff_leading_keys = ["WEB-BFF-AUTHORIZATION#*", "WEB-BFF-SESSION#*", "BFF-IDENTITY-FENCE#*"]
  session_key_arn  = var.data_kms_key_arn
  tags = merge({
    Environment = var.environment
    ManagedBy   = "terraform"
    Product     = "deployments-ai-platform"
    Runtime     = "console"
  }, var.tags)
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "console" {
  name                 = local.name
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

data "aws_iam_policy_document" "console" {
  statement {
    sid       = "WriteLambdaLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }

  statement {
    sid = "BffIdentityPartitions"
    actions = [
      "dynamodb:ConditionCheckItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:TransactWriteItems",
    ]
    resources = [var.identity_table_arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = local.bff_leading_keys
    }
  }

  statement {
    sid       = "SealSessionEnvelopes"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [local.session_key_arn]
    # The shared data key also protects other purposes; BFF envelopes always carry a BFF kind.
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:kind"
      values   = ["web-bff-authorization-transaction", "web-bff-session"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["clientId", "id", "issuer", "kind", "redirectUri", "stage"]
    }
  }

  statement {
    sid       = "ReadWebClientSecret"
    actions   = ["ssm:GetParameter"]
    resources = [var.web_client_secret_arn]
  }
}

resource "aws_iam_role_policy" "console" {
  name   = local.name
  role   = aws_iam_role.console.id
  policy = data.aws_iam_policy_document.console.json
}

resource "aws_iam_role_policy" "console_additional" {
  count  = var.additional_policy_json == null ? 0 : 1
  name   = "${local.name}-additional"
  role   = aws_iam_role.console.id
  policy = var.additional_policy_json
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = var.log_retention_in_days
  tags              = local.tags
}

resource "aws_lambda_function" "console" {
  function_name     = local.name
  description       = "Management console server (TanStack Start BFF)."
  architectures     = ["arm64"]
  handler           = "index.handler"
  memory_size       = 1024
  role              = aws_iam_role.console.arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 29

  environment {
    variables = merge(var.additional_environment, {
      CONSOLE_IDENTITY_ISSUER       = var.identity_issuer
      CONSOLE_IDENTITY_TABLE_NAME   = var.identity_table_name
      CONSOLE_PLATFORM_API_URL      = var.platform_api_url
      CONSOLE_PUBLIC_ORIGIN         = var.application_origin
      CONSOLE_SESSION_KMS_KEY_ARN   = local.session_key_arn
      CONSOLE_WEB_CLIENT_SECRET_ARN = var.web_client_secret_arn
      }, var.oauth_callback_origin == "" ? {} : {
      CONSOLE_OAUTH_CALLBACK_ORIGIN = var.oauth_callback_origin
      }, var.stream_gateway_url == "" ? {} : {
      CONSOLE_STREAM_GATEWAY_URL = var.stream_gateway_url
      }, var.docs_origin == "" ? {} : {
      CONSOLE_DOCS_ORIGIN = var.docs_origin
    })
  }

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.console,
    aws_iam_role_policy.console_additional,
  ]

  tags = local.tags
}
