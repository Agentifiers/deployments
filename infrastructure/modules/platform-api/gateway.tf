resource "aws_apigatewayv2_api" "public" {
  name                         = local.name_prefix
  protocol_type                = "HTTP"
  disable_execute_api_endpoint = true
  tags                         = local.common_tags
}

resource "aws_apigatewayv2_integration" "lambda" {
  for_each = aws_lambda_function.api

  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_uri        = each.value.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

moved {
  from = aws_apigatewayv2_integration.lambda
  to   = aws_apigatewayv2_integration.lambda["tenancy"]
}

resource "aws_apigatewayv2_route" "public" {
  # Path prefixes and the tenancy default route keep the application-authenticated
  # platform surface below API Gateway's 300-route quota as the public contract
  # grows. Exact runtime, email, and memory routes below take precedence.
  for_each = local.api_routes

  api_id             = aws_apigatewayv2_api.public.id
  authorization_type = "NONE"
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.lambda[each.value].id}"

  depends_on = [aws_lambda_permission.api_gateway]
}

resource "aws_apigatewayv2_route" "system_observer" {
  # A full route match outranks ANY /v1/system/{proxy+}, so only these GETs require SigV4. Every
  # other method or path under /v1/system/observer arrives unsigned, and the Lambda refuses it.
  for_each = local.system_observer_routes

  api_id             = aws_apigatewayv2_api.public.id
  authorization_type = "AWS_IAM"
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.lambda["system"].id}"

  depends_on = [aws_lambda_permission.api_gateway]
}

resource "aws_apigatewayv2_route" "system_service" {
  # One SigV4 route for every machine call. The system Lambda maps the rest of the path onto the
  # operator route table and admits only a role in system_service_principals holding its grant.
  count = length(var.system_service_principals) == 0 ? 0 : 1

  api_id             = aws_apigatewayv2_api.public.id
  authorization_type = "AWS_IAM"
  route_key          = "ANY /v1/system/services/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.lambda["system"].id}"

  depends_on = [aws_lambda_permission.api_gateway]
}

resource "aws_apigatewayv2_integration" "runtime" {
  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.runtime_api_invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "runtime" {
  for_each = local.runtime_routes

  api_id             = aws_apigatewayv2_api.public.id
  authorization_type = "NONE"
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.runtime.id}"
}

resource "aws_apigatewayv2_integration" "agent_email" {
  count = var.agent_email_api_enabled ? 1 : 0

  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.agent_email_api_invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "agent_email" {
  for_each = local.agent_email_routes

  api_id             = aws_apigatewayv2_api.public.id
  authorization_type = "NONE"
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.agent_email[0].id}"
}

resource "aws_apigatewayv2_integration" "memory" {
  api_id                 = aws_apigatewayv2_api.public.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.memory_api_invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "memory" {
  for_each = local.memory_routes

  api_id             = aws_apigatewayv2_api.public.id
  authorization_type = "NONE"
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.memory.id}"
}

resource "aws_apigatewayv2_stage" "public" {
  api_id      = aws_apigatewayv2_api.public.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      apiId             = "$context.apiId"
      domainName        = "$context.domainName"
      errorMessage      = "$context.error.message"
      httpMethod        = "$context.httpMethod"
      integrationError  = "$context.integrationErrorMessage"
      integrationStatus = "$context.integration.status"
      ip                = "$context.identity.sourceIp"
      latency           = "$context.responseLatency"
      protocol          = "$context.protocol"
      requestId         = "$context.requestId"
      requestTime       = "$context.requestTime"
      routeKey          = "$context.routeKey"
      status            = "$context.status"
    })
  }

  default_route_settings {
    detailed_metrics_enabled = var.detailed_metrics_enabled
    throttling_burst_limit   = var.throttling_burst_limit
    throttling_rate_limit    = var.throttling_rate_limit
  }

  dynamic "route_settings" {
    for_each = concat(
      var.e2e_mcp_fixture_enabled ? [aws_apigatewayv2_route.e2e_mcp[0].route_key] : [],
      var.e2e_callback_fixture_enabled ? [aws_apigatewayv2_route.e2e_callback[0].route_key] : [],
    )

    content {
      detailed_metrics_enabled = var.detailed_metrics_enabled
      route_key                = route_settings.value
      throttling_burst_limit   = 12
      throttling_rate_limit    = 5
    }
  }

  tags = local.common_tags
}

resource "aws_lambda_permission" "api_gateway" {
  for_each = aws_lambda_function.api

  statement_id  = "AllowPlatformHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/*"
}

moved {
  from = aws_lambda_permission.api_gateway
  to   = aws_lambda_permission.api_gateway["tenancy"]
}

resource "aws_lambda_permission" "runtime_api_gateway" {
  statement_id  = "AllowUnifiedPlatformHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = var.runtime_api_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/*"
}

resource "aws_lambda_permission" "agent_email_api_gateway" {
  count = var.agent_email_api_enabled ? 1 : 0

  statement_id  = "AllowUnifiedPlatformHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = var.agent_email_api_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/*"
}

resource "aws_lambda_permission" "memory_api_gateway" {
  statement_id  = "AllowUnifiedPlatformHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = var.memory_api_function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.public.execution_arn}/*/*"
}

resource "aws_apigatewayv2_domain_name" "public" {
  domain_name = lower(trimspace(var.domain_name))

  domain_name_configuration {
    certificate_arn = var.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  tags = local.common_tags
}

resource "aws_apigatewayv2_api_mapping" "public" {
  api_id      = aws_apigatewayv2_api.public.id
  domain_name = aws_apigatewayv2_domain_name.public.id
  stage       = aws_apigatewayv2_stage.public.id
}

resource "aws_route53_record" "public_ipv4" {
  name    = lower(trimspace(var.domain_name))
  type    = "A"
  zone_id = var.route53_zone_id

  alias {
    evaluate_target_health = false
    name                   = aws_apigatewayv2_domain_name.public.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.public.domain_name_configuration[0].hosted_zone_id
  }
}

resource "aws_route53_record" "public_ipv6" {
  name    = lower(trimspace(var.domain_name))
  type    = "AAAA"
  zone_id = var.route53_zone_id

  alias {
    evaluate_target_health = false
    name                   = aws_apigatewayv2_domain_name.public.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.public.domain_name_configuration[0].hosted_zone_id
  }
}
