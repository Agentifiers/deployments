module "function" {
  source = "../lambda-function"

  name                              = var.name
  filename                          = var.filename
  handler                           = var.handler
  runtime                           = var.runtime
  architecture                      = var.architecture
  timeout                           = var.timeout
  memory_size                       = var.memory_size
  environment                       = var.environment
  secret_environment                = var.secret_environment
  optional_secret_environment_names = var.optional_secret_environment_names
  policy_json                       = var.policy_json
  create_policy                     = var.create_policy
  permissions_boundary_arn          = var.permissions_boundary_arn
  subnet_ids                        = var.subnet_ids
  security_group_ids                = var.security_group_ids
  tags                              = var.tags
}

resource "aws_apigatewayv2_api" "this" {
  name          = var.name
  protocol_type = "HTTP"
  tags          = var.tags
}

resource "aws_apigatewayv2_integration" "this" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.function.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.this.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
  tags        = var.tags
}

resource "aws_lambda_permission" "http_api" {
  statement_id  = "AllowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = module.function.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
