locals {
  use_vpc                  = length(var.subnet_ids) > 0
  runtime_secret_arn_regex = "^arn:[^:]+:ssm:[^:]+:[^:]+:parameter(/.+)$"
  runtime_secret_names     = { for name, arn in var.secret_environment : name => regex(local.runtime_secret_arn_regex, arn)[0] }
  runtime_secret_prefixes = distinct([
    for parameter_name in values(local.runtime_secret_names) : replace(parameter_name, "/[^/]+$/", "")
  ])
  runtime_secret_prefix = length(local.runtime_secret_prefixes) == 1 ? local.runtime_secret_prefixes[0] : ""
  compact_runtime_secret_ids = {
    for name, parameter_name in local.runtime_secret_names : name => trimprefix(parameter_name, local.runtime_secret_prefix)
  }
  environment = merge(
    var.environment,
    length(var.secret_environment) == 0 ? {} : {
      DEPLOYMENTS_AI_TERRAFORM_RUNTIME_SECRET_ARNS   = jsonencode(local.compact_runtime_secret_ids)
      DEPLOYMENTS_AI_TERRAFORM_RUNTIME_SECRET_PREFIX = local.runtime_secret_prefix
    },
    length(var.optional_secret_environment_names) == 0 ? {} : {
      DEPLOYMENTS_AI_TERRAFORM_OPTIONAL_RUNTIME_SECRET_NAMES = jsonencode(sort(tolist(var.optional_secret_environment_names)))
    },
  )
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    effect  = "Allow"

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name_prefix          = substr("${var.name}-", 0, 38)
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn != "" ? var.permissions_boundary_arn : null
  tags                 = var.tags
}

resource "aws_iam_role_policy_attachment" "basic" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "vpc" {
  count = local.use_vpc ? 1 : 0

  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "runtime" {
  count = var.create_policy ? 1 : 0

  name_prefix = "runtime-"
  role        = aws_iam_role.this.id
  policy      = var.policy_json
}

data "aws_iam_policy_document" "runtime_secrets" {
  count = length(var.secret_environment) == 0 ? 0 : 1

  # The runtime hydrator batches reads with GetParameters; SecureStrings use the AWS-managed
  # aws/ssm key, which SSM may use on the caller's behalf without a kms:Decrypt grant.
  statement {
    actions   = ["ssm:GetParameters"]
    resources = distinct(values(var.secret_environment))
  }
}

resource "aws_iam_role_policy" "runtime_secrets" {
  count = length(var.secret_environment) == 0 ? 0 : 1

  name_prefix = "runtime-secrets-"
  role        = aws_iam_role.this.id
  policy      = data.aws_iam_policy_document.runtime_secrets[0].json
}

resource "aws_lambda_function" "this" {
  depends_on = [
    aws_iam_role_policy_attachment.basic,
    aws_iam_role_policy_attachment.vpc,
    aws_iam_role_policy.runtime,
    aws_iam_role_policy.runtime_secrets,
  ]

  function_name    = var.name
  role             = aws_iam_role.this.arn
  runtime          = var.runtime
  architectures    = [var.architecture]
  handler          = var.handler
  filename         = var.filename
  source_code_hash = filebase64sha256(var.filename)
  timeout          = var.timeout
  memory_size      = var.memory_size

  environment {
    variables = local.environment
  }

  dynamic "vpc_config" {
    for_each = local.use_vpc ? [1] : []
    content {
      security_group_ids = var.security_group_ids
      subnet_ids         = var.subnet_ids
    }
  }

  tracing_config {
    mode = "Active"
  }

  tags = var.tags

  lifecycle {
    precondition {
      condition = length(
        setsubtract(var.optional_secret_environment_names, toset(keys(var.secret_environment)))
      ) == 0
      error_message = "optional_secret_environment_names must be keys in secret_environment."
    }

    precondition {
      condition = length(var.secret_environment) == 0 || (
        length(local.runtime_secret_prefixes) == 1 &&
        local.runtime_secret_prefix != "/" &&
        alltrue([
          for secret_id in values(local.compact_runtime_secret_ids) :
          secret_id != "" && !strcontains(secret_id, "/")
        ])
      )
      error_message = "secret_environment ARNs must be SSM parameters under one parameter path below the root."
    }

    precondition {
      condition     = length(jsonencode(local.environment)) <= 4096
      error_message = "Lambda environment variables exceed the 4 KB service limit; move large runtime configuration into a hydrated secret."
    }
  }
}

resource "aws_lambda_function_url" "this" {
  count = var.create_function_url ? 1 : 0

  function_name      = aws_lambda_function.this.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "function_url" {
  count = var.create_function_url ? 1 : 0

  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.this.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "function_url_invoke" {
  count = var.create_function_url ? 1 : 0

  statement_id             = "AllowPublicFunctionUrlInvoke"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.this.function_name
  principal                = "*"
  invoked_via_function_url = true
}
