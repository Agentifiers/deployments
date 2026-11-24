locals {
  app_hosts             = [var.domain, "*.${var.domain}"]
  gateway_listener_port = 9443
  # ACM issues one validation record for a name and its wildcard, and the same record in every
  # Region of an account, so the apex record validates both certificates.
  certificate_validation = one([
    for option in aws_acm_certificate.edge.domain_validation_options : option
    if option.domain_name == var.domain
  ])
  content_security_policy = "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'none'"
  document_extensions     = ["html", "htm", "xhtml", "svg", "xml", "xsl", "pdf"]

  edge_origins = {
    gateway = {
      domain_name              = var.internal_load_balancer.dns_name
      origin_access_control_id = null
      vpc_origin = {
        id           = aws_cloudfront_vpc_origin.gateway.id
        read_timeout = 60
      }
    }
    releases = {
      domain_name              = aws_s3_bucket.apps.bucket_regional_domain_name
      origin_access_control_id = aws_cloudfront_origin_access_control.releases.id
      vpc_origin               = null
    }
  }
  edge_behaviors = {
    releases = {
      allowed_methods          = ["GET", "HEAD"]
      cache_policy_id          = aws_cloudfront_cache_policy.releases.id
      cached_methods           = ["GET", "HEAD"]
      compress                 = true
      origin_request_policy_id = null
      path_pattern             = "/_r/*"
      viewer_protocol_policy   = "redirect-to-https"
    }
    gateway = {
      allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
      cached_methods           = ["GET", "HEAD"]
      compress                 = false
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
      path_pattern             = null
      viewer_protocol_policy   = "redirect-to-https"
    }
  }
}

resource "aws_acm_certificate" "edge" {
  provider = aws.us_east_1

  domain_name               = var.domain
  subject_alternative_names = ["*.${var.domain}"]
  validation_method         = "DNS"
  tags                      = merge(local.common_tags, { Name = "${local.name}-edge" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate" "origin" {
  domain_name               = var.domain
  subject_alternative_names = ["*.${var.domain}"]
  validation_method         = "DNS"
  tags                      = merge(local.common_tags, { Name = "${local.name}-origin" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  allow_overwrite = true
  name            = local.certificate_validation.resource_record_name
  records         = [local.certificate_validation.resource_record_value]
  ttl             = 60
  type            = local.certificate_validation.resource_record_type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "edge" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.edge.arn
  validation_record_fqdns = [aws_route53_record.certificate_validation.fqdn]
}

resource "aws_acm_certificate_validation" "origin" {
  certificate_arn         = aws_acm_certificate.origin.arn
  validation_record_fqdns = [aws_route53_record.certificate_validation.fqdn]
}

resource "aws_cloudfront_key_value_store" "app_hosts" {
  name    = local.name
  comment = "App slug to app id; the apps-database Lambda writes an entry at create and removes it at erasure"
}

resource "aws_cloudfront_function" "viewer_request" {
  name                         = "${local.name}-viewer-request"
  comment                      = "Resolve the app from the host or the distribution tenant, route release assets to S3, and stamp the app for the gateway"
  runtime                      = "cloudfront-js-2.0"
  publish                      = true
  code                         = templatefile("${path.module}/viewer-request.js", { apps_domain = var.domain, document_extensions = join("|", local.document_extensions) })
  key_value_store_associations = [aws_cloudfront_key_value_store.app_hosts.arn]
}

resource "aws_cloudfront_origin_access_control" "releases" {
  name                              = local.name
  description                       = "Signed CloudFront reads of app release objects"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_cache_policy" "releases" {
  name        = "${local.name}-releases"
  comment     = "Release objects never change under their release id"
  min_ttl     = 31536000
  default_ttl = 31536000
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# An origin request policy cannot list Authorization by name.
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

resource "aws_cloudfront_response_headers_policy" "apps" {
  name    = local.name
  comment = "Browser isolation for agent-written app code"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }

    content_type_options {
      override = true
    }

    referrer_policy {
      override        = true
      referrer_policy = "strict-origin-when-cross-origin"
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
  }
}

# A tenant's domain may be a customer's apex, so HSTS must not claim the customer's other hosts.
resource "aws_cloudfront_response_headers_policy" "custom_domains" {
  name    = "${local.name}-custom-domains"
  comment = "Browser isolation for agent-written app code on custom domains"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }

    content_type_options {
      override = true
    }

    referrer_policy {
      override        = true
      referrer_policy = "strict-origin-when-cross-origin"
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      override                   = true
    }
  }
}

resource "aws_cloudfront_vpc_origin" "gateway" {
  vpc_origin_endpoint_config {
    name                   = "${local.name}-gateway"
    arn                    = var.internal_load_balancer.arn
    http_port              = 80
    https_port             = local.gateway_listener_port
    origin_protocol_policy = "https-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }

  tags = local.common_tags
}

# CloudFront creates this service-managed group with the VPC's first VPC origin.
data "aws_security_group" "cloudfront_vpc_origins" {
  vpc_id = var.vpc_id

  filter {
    name   = "group-name"
    values = ["CloudFront-VPCOrigins-Service-SG"]
  }

  depends_on = [aws_cloudfront_vpc_origin.gateway]
}

resource "aws_vpc_security_group_ingress_rule" "load_balancer_from_cloudfront" {
  security_group_id            = var.internal_load_balancer.security_group_id
  referenced_security_group_id = data.aws_security_group.cloudfront_vpc_origins.id
  from_port                    = local.gateway_listener_port
  to_port                      = local.gateway_listener_port
  ip_protocol                  = "tcp"
}

resource "aws_cloudfront_distribution" "apps" {
  aliases         = local.app_hosts
  comment         = "Agent-built apps"
  enabled         = true
  http_version    = "http2and3"
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"

  dynamic "origin" {
    for_each = local.edge_origins

    content {
      domain_name              = origin.value.domain_name
      origin_access_control_id = origin.value.origin_access_control_id
      origin_id                = origin.key

      dynamic "vpc_origin_config" {
        for_each = origin.value.vpc_origin[*]

        content {
          origin_read_timeout = vpc_origin_config.value.read_timeout
          vpc_origin_id       = vpc_origin_config.value.id
        }
      }
    }
  }

  ordered_cache_behavior {
    path_pattern               = local.edge_behaviors.releases.path_pattern
    allowed_methods            = local.edge_behaviors.releases.allowed_methods
    cached_methods             = local.edge_behaviors.releases.cached_methods
    cache_policy_id            = local.edge_behaviors.releases.cache_policy_id
    compress                   = local.edge_behaviors.releases.compress
    origin_request_policy_id   = local.edge_behaviors.releases.origin_request_policy_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.apps.id
    target_origin_id           = "releases"
    viewer_protocol_policy     = local.edge_behaviors.releases.viewer_protocol_policy

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.viewer_request.arn
    }
  }

  default_cache_behavior {
    allowed_methods            = local.edge_behaviors.gateway.allowed_methods
    cached_methods             = local.edge_behaviors.gateway.cached_methods
    cache_policy_id            = local.edge_behaviors.gateway.cache_policy_id
    compress                   = local.edge_behaviors.gateway.compress
    origin_request_policy_id   = local.edge_behaviors.gateway.origin_request_policy_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.apps.id
    target_origin_id           = "gateway"
    viewer_protocol_policy     = local.edge_behaviors.gateway.viewer_protocol_policy

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.viewer_request.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.edge.certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  depends_on = [aws_lb_listener.gateway, aws_vpc_security_group_ingress_rule.load_balancer_from_cloudfront]

  tags = merge(local.common_tags, { Name = var.domain })
}

resource "aws_cloudfront_connection_group" "custom_domains" {
  name         = "${local.name}-custom-domains"
  enabled      = true
  ipv6_enabled = true
  tags         = merge(local.common_tags, { Name = "${local.name}-custom-domains" })
}

resource "aws_cloudfront_multitenant_distribution" "custom_domains" {
  comment      = "Agent-built apps on custom domains"
  enabled      = true
  http_version = "http2and3"

  dynamic "origin" {
    for_each = local.edge_origins

    content {
      domain_name              = origin.value.domain_name
      id                       = origin.key
      origin_access_control_id = origin.value.origin_access_control_id

      dynamic "vpc_origin_config" {
        for_each = origin.value.vpc_origin[*]

        content {
          origin_read_timeout = vpc_origin_config.value.read_timeout
          vpc_origin_id       = vpc_origin_config.value.id
        }
      }
    }
  }

  cache_behavior {
    path_pattern               = local.edge_behaviors.releases.path_pattern
    cache_policy_id            = local.edge_behaviors.releases.cache_policy_id
    compress                   = local.edge_behaviors.releases.compress
    origin_request_policy_id   = local.edge_behaviors.releases.origin_request_policy_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.custom_domains.id
    target_origin_id           = "releases"
    viewer_protocol_policy     = local.edge_behaviors.releases.viewer_protocol_policy

    allowed_methods {
      cached_methods = local.edge_behaviors.releases.cached_methods
      items          = local.edge_behaviors.releases.allowed_methods
    }

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.viewer_request.arn
    }
  }

  default_cache_behavior {
    cache_policy_id            = local.edge_behaviors.gateway.cache_policy_id
    compress                   = local.edge_behaviors.gateway.compress
    origin_request_policy_id   = local.edge_behaviors.gateway.origin_request_policy_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.custom_domains.id
    target_origin_id           = "gateway"
    viewer_protocol_policy     = local.edge_behaviors.gateway.viewer_protocol_policy

    allowed_methods {
      cached_methods = local.edge_behaviors.gateway.cached_methods
      items          = local.edge_behaviors.gateway.allowed_methods
    }

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.viewer_request.arn
    }
  }

  tenant_config {
    parameter_definition {
      name = "appId"

      definition {
        string_schema {
          comment  = "App the tenant's domain serves"
          required = true
        }
      }
    }
  }

  # CloudFront always returns a geo restriction; declaring it keeps the plan and the
  # provider's post-apply value in agreement.
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.edge.certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  depends_on = [aws_lb_listener.gateway, aws_vpc_security_group_ingress_rule.load_balancer_from_cloudfront]

  tags = merge(local.common_tags, { Name = "${local.name}-custom-domains" })
}

resource "aws_route53_record" "alias" {
  for_each = {
    for pair in setproduct(local.app_hosts, ["A", "AAAA"]) : "${pair[0]} ${pair[1]}" => {
      name = pair[0]
      type = pair[1]
    }
  }

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type

  alias {
    evaluate_target_health = false
    name                   = aws_cloudfront_distribution.apps.domain_name
    zone_id                = aws_cloudfront_distribution.apps.hosted_zone_id
  }
}
