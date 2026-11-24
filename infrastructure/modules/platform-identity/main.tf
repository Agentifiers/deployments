data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  name                    = "identity"
  issuer                  = "https://${var.domain_name}"
  signing_key_arn         = one(concat(aws_kms_key.signing_unprotected[*].arn, aws_kms_key.signing_protected[*].arn))
  signing_key_id          = one(concat(aws_kms_key.signing_unprotected[*].key_id, aws_kms_key.signing_protected[*].key_id))
  email_key_arn           = var.data_kms_key_arn
  parameter_arn_prefix    = "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter"
  web_client_secret_arn   = "${local.parameter_arn_prefix}/${local.name}/web-oauth-client"
  e2e_client_secret_arn   = var.e2e_client_enabled ? "${local.parameter_arn_prefix}/${local.name}/e2e-oauth-client" : ""
  email_max_receive_count = 5
  email_domain            = split("@", var.email_sender)[1]
  certificate_arn         = trimspace(var.certificate_arn) != "" ? var.certificate_arn : try(aws_acm_certificate.identity[0].arn, "")
  tags = merge({
    Environment = var.environment
    ManagedBy   = "terraform"
    Product     = "deployments-ai-platform"
  }, var.tags)
}

# The confidential client secrets are SecureString parameters under /identity/ that the deploy
# tool's client bootstrap writes; OpenTofu only names them, so no value reaches state. The
# Secrets Manager secrets of earlier releases stay in the account until an operator deletes them.
removed {
  from = aws_secretsmanager_secret.web_client_unprotected
  lifecycle { destroy = false }
}

removed {
  from = aws_secretsmanager_secret.web_client_protected
  lifecycle { destroy = false }
}

removed {
  from = aws_secretsmanager_secret.e2e_client
  lifecycle { destroy = false }
}

resource "aws_kms_key" "signing_unprotected" {
  count                    = var.deletion_protection_enabled ? 0 : 1
  description              = "${local.name} OAuth and OIDC signing"
  customer_master_key_spec = "RSA_2048"
  deletion_window_in_days  = var.kms_deletion_window_in_days
  key_usage                = "SIGN_VERIFY"
  tags                     = merge(local.tags, { Name = "${local.name}-signing" })

}

resource "aws_kms_key" "signing_protected" {
  count                    = var.deletion_protection_enabled ? 1 : 0
  description              = "${local.name} OAuth and OIDC signing"
  customer_master_key_spec = "RSA_2048"
  deletion_window_in_days  = 30
  key_usage                = "SIGN_VERIFY"
  tags                     = merge(local.tags, { Name = "${local.name}-signing" })

  lifecycle { prevent_destroy = true }
}

resource "aws_kms_alias" "signing" {
  name          = "alias/${local.name}-signing"
  target_key_id = local.signing_key_id
}

resource "aws_sqs_queue" "email_dlq" {
  name                      = "${local.name}-email-dlq.fifo"
  fifo_queue                = true
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
  tags                      = local.tags
}

resource "aws_sqs_queue" "email" {
  name                       = "${local.name}-email.fifo"
  fifo_queue                 = true
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 120
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.email_dlq.arn
    maxReceiveCount     = local.email_max_receive_count
  })
  tags = local.tags
}

resource "aws_sqs_queue" "public_email_request_dlq" {
  name                      = "${local.name}-public-email-request-dlq"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
  tags                      = local.tags
}

resource "aws_sqs_queue" "public_email_request" {
  name                       = "${local.name}-public-email-request"
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 60
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.public_email_request_dlq.arn
    maxReceiveCount     = local.email_max_receive_count
  })
  tags = local.tags
}

data "aws_iam_policy_document" "email_queue" {
  for_each = {
    email                    = aws_sqs_queue.email.arn
    email_dlq                = aws_sqs_queue.email_dlq.arn
    public_email_request     = aws_sqs_queue.public_email_request.arn
    public_email_request_dlq = aws_sqs_queue.public_email_request_dlq.arn
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [each.value]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "email" {
  queue_url = aws_sqs_queue.email.id
  policy    = data.aws_iam_policy_document.email_queue["email"].json
}

resource "aws_sqs_queue_policy" "email_dlq" {
  queue_url = aws_sqs_queue.email_dlq.id
  policy    = data.aws_iam_policy_document.email_queue["email_dlq"].json
}

resource "aws_sqs_queue_policy" "public_email_request" {
  queue_url = aws_sqs_queue.public_email_request.id
  policy    = data.aws_iam_policy_document.email_queue["public_email_request"].json
}

resource "aws_sqs_queue_policy" "public_email_request_dlq" {
  queue_url = aws_sqs_queue.public_email_request_dlq.id
  policy    = data.aws_iam_policy_document.email_queue["public_email_request_dlq"].json
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

resource "aws_iam_role" "api" {
  name                 = "${local.name}-api"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role" "dispatcher" {
  name                 = "${local.name}-email-dispatcher"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role" "worker" {
  name                 = "${local.name}-email-worker"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role" "reconciler" {
  name                 = "${local.name}-email-reconciler"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role" "public_email_worker" {
  name                 = "${local.name}-public-email-worker"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

locals {
  function_names = {
    api                 = "${local.name}-api"
    dispatcher          = "${local.name}-email-dispatcher"
    principal_status    = "${local.name}-principal-status"
    public_email_worker = "${local.name}-public-email-worker"
    reconciler          = "${local.name}-email-reconciler"
    worker              = "${local.name}-email-worker"
  }
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each = local.function_names

  name              = "/aws/lambda/${each.value}"
  retention_in_days = var.log_retention_in_days
  tags              = local.tags
}

resource "aws_iam_role_policy" "logs" {
  for_each = {
    api                 = aws_iam_role.api.id
    dispatcher          = aws_iam_role.dispatcher.id
    principal_status    = aws_iam_role.principal_status.id
    public_email_worker = aws_iam_role.public_email_worker.id
    reconciler          = aws_iam_role.reconciler.id
    worker              = aws_iam_role.worker.id
  }
  name = "write-logs"
  role = each.value
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.lambda[each.key].arn}:*"
    }]
  })
}

locals {
  # Email payload envelopes use the shared platform data key. Every identity email context names
  # this stage and a delivery and nothing outside the delivery binding, so these grants cannot
  # seal or open envelopes that belong to another purpose of the shared key.
  email_envelope_condition = {
    "ForAllValues:StringEquals" = { "kms:EncryptionContextKeys" = ["actionId", "deliveryId", "invitationId", "purpose", "stage"] }
    Null                        = { "kms:EncryptionContext:deliveryId" = "false" }
    StringEquals                = { "kms:EncryptionContext:stage" = var.environment }
  }
}

locals {
  human_verification_parameter_arns = var.human_verification == null ? [] : [
    "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${trimprefix(var.human_verification.secret_parameter_name, "/")}"
  ]
  human_verification_environment = var.human_verification == null ? {} : {
    DEPLOYMENTS_AI_IDENTITY_HUMAN_VERIFICATION = jsonencode({
      responseField      = var.human_verification.response_field
      scriptUrl          = var.human_verification.script_url
      secretParameterArn = one(local.human_verification_parameter_arns)
      siteKey            = var.human_verification.site_key
      verifyUrl          = var.human_verification.verify_url
      widgetClass        = var.human_verification.widget_class
      widgetOrigins      = var.human_verification.widget_origins
    })
  }
}

resource "aws_iam_role_policy" "api" {
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Effect = "Allow"
        Action = ["dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:TransactWriteItems"]
        Resource = [
          var.control_table_arn,
          "${var.control_table_arn}/index/*",
          var.identity_table_arn,
          "${var.identity_table_arn}/index/*",
          var.events_table_arn,
          "${var.events_table_arn}/index/*",
          var.identity_email_table_arn,
          "${var.identity_email_table_arn}/index/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GetPublicKey", "kms:Sign"]
        Resource = local.signing_key_arn
      },
      {
        Effect    = "Allow"
        Action    = ["kms:GenerateDataKey"]
        Resource  = local.email_key_arn
        Condition = local.email_envelope_condition
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.public_email_request.arn
      }
      ], [for parameter_arn in local.human_verification_parameter_arns : {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = parameter_arn
    }])
  })
}

resource "aws_iam_role_policy" "public_email_worker" {
  role = aws_iam_role.public_email_worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:TransactWriteItems"]
        Resource = [
          var.control_table_arn,
          "${var.control_table_arn}/index/*",
          var.identity_table_arn,
          "${var.identity_table_arn}/index/*",
          var.events_table_arn,
          "${var.events_table_arn}/index/*",
          var.identity_email_table_arn,
          "${var.identity_email_table_arn}/index/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"]
        Resource = aws_sqs_queue.public_email_request.arn
      },
      {
        Effect    = "Allow"
        Action    = ["kms:GenerateDataKey"]
        Resource  = local.email_key_arn
        Condition = local.email_envelope_condition
      }
    ]
  })
}

resource "aws_iam_role_policy" "dispatcher" {
  role = aws_iam_role.dispatcher.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"]
        Resource = var.identity_email_stream_arn
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:TransactWriteItems"]
        Resource = var.identity_email_table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.email.arn
      }
    ]
  })
}

resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:TransactWriteItems"]
        Resource = var.identity_email_table_arn
      },
      {
        Effect = "Allow"
        Action = ["dynamodb:GetItem"]
        Resource = [
          var.control_table_arn,
          var.identity_table_arn
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"]
        Resource = aws_sqs_queue.email.arn
      },
      {
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = local.email_key_arn
        Condition = local.email_envelope_condition
      },
      {
        Effect   = "Allow"
        Action   = ["ses:SendEmail"]
        Resource = aws_ses_domain_identity.identity.arn
      }
    ]
  })
}

resource "aws_iam_role_policy" "reconciler" {
  role = aws_iam_role.reconciler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:TransactWriteItems"]
        Resource = [
          var.identity_email_table_arn,
          "${var.identity_email_table_arn}/index/gsi1"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.email.arn
      }
    ]
  })
}

locals {
  database_environment = {
    DEPLOYMENTS_AI_CONTROL_TABLE               = var.control_table_name
    DEPLOYMENTS_AI_EVENTS_TABLE                = var.events_table_name
    DEPLOYMENTS_AI_IDENTITY_TABLE              = var.identity_table_name
    DEPLOYMENTS_AI_IDENTITY_EMAIL_OUTBOX_TABLE = var.identity_email_table_name
  }
}

resource "aws_lambda_function" "api" {
  function_name                  = local.function_names.api
  role                           = aws_iam_role.api.arn
  handler                        = "lambda-main.handler"
  runtime                        = "nodejs26.x"
  s3_bucket                      = var.api_artifact_bucket
  s3_key                         = var.api_artifact_key
  s3_object_version              = var.api_artifact_version
  memory_size                    = 1024
  timeout                        = 15
  reserved_concurrent_executions = var.api_reserved_concurrency
  depends_on                     = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.logs]

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = merge(local.database_environment, local.human_verification_environment, {
      DEPLOYMENTS_AI_IDENTITY_APPLICATION_ORIGIN         = var.application_origin
      DEPLOYMENTS_AI_IDENTITY_EMAIL_KMS_KEY_ID           = local.email_key_arn
      DEPLOYMENTS_AI_IDENTITY_FEDERATION_KMS_KEY_ID      = local.federation_key_arn
      DEPLOYMENTS_AI_IDENTITY_ISSUER                     = local.issuer
      DEPLOYMENTS_AI_IDENTITY_PUBLIC_RESPONSE_MINIMUM_MS = "500"
      DEPLOYMENTS_AI_IDENTITY_PUBLIC_EMAIL_QUEUE_URL     = aws_sqs_queue.public_email_request.url
      DEPLOYMENTS_AI_IDENTITY_REGISTRATION_ENABLED       = tostring(var.registration_enabled)
      DEPLOYMENTS_AI_IDENTITY_RESOURCE_AUDIENCE          = var.resource_audience
      DEPLOYMENTS_AI_IDENTITY_SIGNING_KEY_ID             = local.signing_key_arn
      DEPLOYMENTS_AI_IDENTITY_SIGNING_KID                = var.signing_kid
      DEPLOYMENTS_AI_IDENTITY_UI_ORIGIN                  = local.issuer
      DEPLOYMENTS_AI_STAGE                               = var.environment
    })
  }
  tags = local.tags
}

resource "aws_lambda_function" "public_email_worker" {
  function_name     = local.function_names.public_email_worker
  role              = aws_iam_role.public_email_worker.arn
  handler           = "public-email-worker.handler"
  runtime           = "nodejs26.x"
  s3_bucket         = var.api_artifact_bucket
  s3_key            = var.api_artifact_key
  s3_object_version = var.api_artifact_version
  memory_size       = 1024
  timeout           = 30
  depends_on        = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.logs]

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = merge(local.database_environment, {
      DEPLOYMENTS_AI_IDENTITY_EMAIL_KMS_KEY_ID = local.email_key_arn
      DEPLOYMENTS_AI_STAGE                     = var.environment
    })
  }
  tags = local.tags
}

resource "aws_lambda_function" "dispatcher" {
  function_name     = local.function_names.dispatcher
  role              = aws_iam_role.dispatcher.arn
  handler           = "dispatcher.handler"
  runtime           = "nodejs26.x"
  s3_bucket         = var.email_artifact_bucket
  s3_key            = var.email_artifact_key
  s3_object_version = var.email_artifact_version
  memory_size       = 512
  timeout           = 30
  depends_on        = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.logs]

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = merge(local.database_environment, {
      DEPLOYMENTS_AI_IDENTITY_EMAIL_QUEUE_URL = aws_sqs_queue.email.url
      DEPLOYMENTS_AI_STAGE                    = var.environment
    })
  }
  tags = local.tags
}

resource "aws_lambda_function" "worker" {
  function_name     = local.function_names.worker
  role              = aws_iam_role.worker.arn
  handler           = "worker.handler"
  runtime           = "nodejs26.x"
  s3_bucket         = var.email_artifact_bucket
  s3_key            = var.email_artifact_key
  s3_object_version = var.email_artifact_version
  memory_size       = 512
  timeout           = 60
  depends_on        = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.logs]

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = merge(local.database_environment, {
      DEPLOYMENTS_AI_IDENTITY_APPLICATION_ORIGIN      = var.application_origin
      DEPLOYMENTS_AI_IDENTITY_EMAIL_KMS_KEY_ID        = local.email_key_arn
      DEPLOYMENTS_AI_IDENTITY_EMAIL_MAX_RECEIVE_COUNT = tostring(local.email_max_receive_count)
      DEPLOYMENTS_AI_IDENTITY_EMAIL_SENDER            = var.email_sender
      DEPLOYMENTS_AI_IDENTITY_ISSUER                  = local.issuer
      DEPLOYMENTS_AI_STAGE                            = var.environment
    })
  }
  tags = local.tags
}

resource "aws_lambda_function" "reconciler" {
  function_name     = local.function_names.reconciler
  role              = aws_iam_role.reconciler.arn
  handler           = "reconciler.handler"
  runtime           = "nodejs26.x"
  s3_bucket         = var.email_artifact_bucket
  s3_key            = var.email_artifact_key
  s3_object_version = var.email_artifact_version
  memory_size       = 256
  timeout           = 30
  depends_on        = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.logs]

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = merge(local.database_environment, {
      DEPLOYMENTS_AI_IDENTITY_EMAIL_QUEUE_URL = aws_sqs_queue.email.url
      DEPLOYMENTS_AI_STAGE                    = var.environment
    })
  }
  tags = local.tags
}
