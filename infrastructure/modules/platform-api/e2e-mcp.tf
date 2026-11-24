resource "aws_cloudwatch_log_group" "e2e_mcp" {
  count = var.e2e_mcp_fixture_enabled ? 1 : 0

  name              = "/aws/lambda/e2e-mcp"
  retention_in_days = 7
  tags              = local.common_tags
}

resource "aws_iam_role" "e2e_mcp" {
  count = var.e2e_mcp_fixture_enabled ? 1 : 0

  name                 = "e2e-mcp"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.common_tags
}

resource "aws_iam_role_policy" "e2e_mcp" {
  count = var.e2e_mcp_fixture_enabled ? 1 : 0

  name = "write-logs"
  role = aws_iam_role.e2e_mcp[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.e2e_mcp[0].arn}:*"
      },
      {
        Sid      = "ReadFixtureCredential"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = aws_ssm_parameter.e2e_mcp[0].arn
      },
    ]
  })
}

resource "random_password" "e2e_mcp_initial" {
  count = var.e2e_mcp_fixture_enabled ? 1 : 0

  length  = 64
  special = false
}

resource "random_password" "e2e_mcp_rotated" {
  count = var.e2e_mcp_fixture_enabled ? 1 : 0

  length  = 64
  special = false
}

resource "aws_ssm_parameter" "e2e_mcp" {
  count = var.e2e_mcp_fixture_enabled ? 1 : 0

  name        = "/e2e/mcp"
  description = "Development E2E MCP bearer-token fixtures."
  type        = "SecureString"
  value = jsonencode({
    initial = random_password.e2e_mcp_initial[0].result
    rotated = random_password.e2e_mcp_rotated[0].result
  })
}

resource "aws_lambda_function" "e2e_mcp" {
  count = var.e2e_mcp_fixture_enabled ? 1 : 0

  function_name     = "e2e-mcp"
  description       = "Development-only deterministic MCP server for deployed end-to-end evidence."
  architectures     = ["arm64"]
  handler           = "e2e-mcp-main.handler"
  memory_size       = 128
  role              = aws_iam_role.e2e_mcp[0].arn
  runtime           = "nodejs26.x"
  s3_bucket         = var.artifact_bucket
  s3_key            = var.artifact_key
  s3_object_version = var.artifact_version
  timeout           = 10

  environment {
    variables = {
      DEPLOYMENTS_AI_E2E_MCP_SECRET_ARN = aws_ssm_parameter.e2e_mcp[0].arn
    }
  }

  lifecycle {
    ignore_changes = [s3_bucket, s3_key, s3_object_version]
  }

  tags = local.common_tags

  depends_on = [
    aws_cloudwatch_log_group.e2e_mcp,
    aws_iam_role_policy.e2e_mcp,
  ]
}

resource "aws_apigatewayv2_integration" "e2e_mcp" {
  count = var.e2e_mcp_fixture_enabled ? 1 : 0

  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.e2e_mcp[0].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}

resource "aws_apigatewayv2_route" "e2e_mcp" {
  count = var.e2e_mcp_fixture_enabled ? 1 : 0

  api_id             = aws_apigatewayv2_api.public.id
  authorization_type = "NONE"
  route_key          = "ANY /_e2e/mcp/{credential}"
  target             = "integrations/${aws_apigatewayv2_integration.e2e_mcp[0].id}"
}

resource "aws_lambda_permission" "e2e_mcp" {
  count = var.e2e_mcp_fixture_enabled ? 1 : 0

  statement_id  = "AllowPlatformHttpApiE2eMcp"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.e2e_mcp[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/*/_e2e/mcp/*"
}
