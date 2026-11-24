# CloudFront reaches the console server through a regional HTTP API rather than a Lambda
# function URL with origin access control: OAC-signed function URLs require browsers to send a
# payload SHA-256 header on every POST, which form posts and server functions cannot do.
resource "aws_apigatewayv2_api" "console" {
  name          = local.name
  protocol_type = "HTTP"
  tags          = local.tags
}

resource "aws_apigatewayv2_integration" "console" {
  api_id                 = aws_apigatewayv2_api.console.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.console.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "console" {
  api_id             = aws_apigatewayv2_api.console.id
  authorization_type = "NONE"
  route_key          = "$default"
  target             = "integrations/${aws_apigatewayv2_integration.console.id}"
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${local.name}"
  retention_in_days = var.log_retention_in_days
  tags              = local.tags
}

resource "aws_apigatewayv2_stage" "console" {
  api_id      = aws_apigatewayv2_api.console.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      httpMethod        = "$context.httpMethod"
      integrationError  = "$context.integrationErrorMessage"
      integrationStatus = "$context.integration.status"
      ip                = "$context.identity.sourceIp"
      latency           = "$context.responseLatency"
      path              = "$context.path"
      requestId         = "$context.requestId"
      requestTime       = "$context.requestTime"
      status            = "$context.status"
    })
  }

  default_route_settings {
    detailed_metrics_enabled = var.detailed_metrics_enabled
    throttling_burst_limit   = 100
    throttling_rate_limit    = 50
  }

  tags = local.tags
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowConsoleHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.console.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.console.execution_arn}/*/*"
}
