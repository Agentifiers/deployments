resource "aws_api_gateway_rest_api" "identity" {
  name                         = local.name
  disable_execute_api_endpoint = true
  endpoint_configuration {
    types = ["REGIONAL"]
  }
  tags = local.tags
}

resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.identity.id
  parent_id   = aws_api_gateway_rest_api.identity.root_resource_id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "proxy" {
  rest_api_id   = aws_api_gateway_rest_api.identity.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "proxy" {
  rest_api_id             = aws_api_gateway_rest_api.identity.id
  resource_id             = aws_api_gateway_resource.proxy.id
  http_method             = aws_api_gateway_method.proxy.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.api.invoke_arn
}

resource "aws_api_gateway_method" "root" {
  rest_api_id   = aws_api_gateway_rest_api.identity.id
  resource_id   = aws_api_gateway_rest_api.identity.root_resource_id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "root" {
  rest_api_id             = aws_api_gateway_rest_api.identity.id
  resource_id             = aws_api_gateway_rest_api.identity.root_resource_id
  http_method             = aws_api_gateway_method.root.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.api.invoke_arn
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowIdentityRestApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.identity.execution_arn}/*/*"
}

resource "aws_api_gateway_deployment" "identity" {
  rest_api_id = aws_api_gateway_rest_api.identity.id
  triggers = { redeployment = sha1(jsonencode([
    aws_api_gateway_integration.proxy.id,
    aws_api_gateway_integration.proxy.uri,
    aws_api_gateway_integration.root.id,
    aws_api_gateway_integration.root.uri,
  ])) }
  lifecycle { create_before_destroy = true }
}

resource "aws_api_gateway_stage" "identity" {
  deployment_id = aws_api_gateway_deployment.identity.id
  rest_api_id   = aws_api_gateway_rest_api.identity.id
  stage_name    = var.environment
  tags          = local.tags
}

resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.identity.id
  stage_name  = aws_api_gateway_stage.identity.stage_name
  method_path = "*/*"
  settings {
    metrics_enabled        = var.detailed_metrics_enabled
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }
}

resource "aws_api_gateway_domain_name" "identity" {
  count                    = var.publish_domain ? 1 : 0
  domain_name              = var.domain_name
  regional_certificate_arn = local.certificate_arn
  endpoint_configuration {
    types = ["REGIONAL"]
  }
  security_policy = "TLS_1_2"
  tags            = local.tags

  lifecycle {
    precondition {
      condition     = local.certificate_arn != ""
      error_message = "Publishing the identity domain requires certificate_arn or a Route 53 zone for a managed certificate."
    }
  }

  depends_on = [aws_acm_certificate_validation.identity]
}

resource "aws_api_gateway_base_path_mapping" "identity" {
  count       = var.publish_domain ? 1 : 0
  api_id      = aws_api_gateway_rest_api.identity.id
  stage_name  = aws_api_gateway_stage.identity.stage_name
  domain_name = aws_api_gateway_domain_name.identity[0].domain_name
}

resource "aws_route53_record" "identity" {
  count   = var.publish_domain && var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    evaluate_target_health = false
    name                   = aws_api_gateway_domain_name.identity[0].regional_domain_name
    zone_id                = aws_api_gateway_domain_name.identity[0].regional_zone_id
  }
}

resource "aws_wafv2_web_acl" "identity" {
  count = var.web_application_firewall_enabled ? 1 : 0

  name  = local.name
  scope = "REGIONAL"
  default_action {
    allow {}
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = replace(local.name, "-", "_")
    sampled_requests_enabled   = false
  }
  rule {
    name     = "aws-managed-common"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws_managed_common"
      sampled_requests_enabled   = false
    }
  }
  # IdP SAMLResponse form posts routinely exceed the managed 8 KB body limit, so that rule only
  # labels and this rule blocks oversized bodies everywhere except the SAML ACS, whose Lambda
  # enforces its own limit.
  rule {
    name     = "body-size-outside-saml-acs"
    priority = 2
    action {
      block {}
    }
    statement {
      and_statement {
        statement {
          label_match_statement {
            scope = "LABEL"
            key   = "awswaf:managed:aws:core-rule-set:SizeRestrictions_Body"
          }
        }
        statement {
          not_statement {
            statement {
              regex_match_statement {
                regex_string = "^/saml/[0-9A-HJKMNP-TV-Z]{26}/acs$"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "body_size_outside_saml_acs"
      sampled_requests_enabled   = false
    }
  }
  rule {
    name     = "coarse-ip-rate-limit"
    priority = 3
    action {
      block {}
    }
    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = var.waf_rate_limit
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "coarse_ip_rate_limit"
      sampled_requests_enabled   = false
    }
  }
  tags = local.tags
}

resource "aws_wafv2_web_acl_association" "identity" {
  count = var.web_application_firewall_enabled ? 1 : 0

  resource_arn = "arn:${data.aws_partition.current.partition}:apigateway:${data.aws_region.current.region}::/restapis/${aws_api_gateway_rest_api.identity.id}/stages/${aws_api_gateway_stage.identity.stage_name}"
  web_acl_arn  = aws_wafv2_web_acl.identity[0].arn
}
