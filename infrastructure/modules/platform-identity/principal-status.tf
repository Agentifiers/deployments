# The platform API changes a person's status, describes their sign-in state, ends their sessions,
# and resends a sign-up's verification email by invoking this function, so the API's own role never
# reads or writes the identity table that holds credentials, sessions, and refresh tokens.
resource "aws_iam_role" "principal_status" {
  name                 = "${local.name}-principal-status"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role_policy" "principal_status" {
  role = aws_iam_role.principal_status.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:TransactWriteItems"]
        Resource = [var.control_table_arn, var.identity_table_arn, var.events_table_arn, var.identity_email_table_arn]
      },
      # Counting a person's sessions and refresh token families, both listed on gsi1.
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = ["${var.identity_table_arn}/index/gsi1"]
      },
      # Sealing a reissued verification email into the identity email outbox.
      {
        Effect    = "Allow"
        Action    = ["kms:GenerateDataKey"]
        Resource  = local.email_key_arn
        Condition = local.email_envelope_condition
      }
    ]
  })
}

resource "aws_lambda_function" "principal_status" {
  function_name     = local.function_names.principal_status
  role              = aws_iam_role.principal_status.arn
  handler           = "principal-status.handler"
  runtime           = "nodejs26.x"
  s3_bucket         = var.api_artifact_bucket
  s3_key            = var.api_artifact_key
  s3_object_version = var.api_artifact_version
  memory_size       = 512
  timeout           = 15
  depends_on        = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.logs]

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  environment {
    variables = merge(local.database_environment, {
      DEPLOYMENTS_AI_IDENTITY_EMAIL_KMS_KEY_ID     = local.email_key_arn
      DEPLOYMENTS_AI_IDENTITY_REGISTRATION_ENABLED = tostring(var.registration_enabled)
      DEPLOYMENTS_AI_STAGE                         = var.environment
    })
  }
  tags = local.tags
}
