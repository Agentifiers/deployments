# With shared_load_balancer set, the gateway has no internet-facing load balancer: CloudFront
# terminates viewer TLS and reaches the HTTPS listener on the shared internal ALB through a VPC
# origin, so the gateway path has no public IPs.

resource "aws_cloudfront_vpc_origin" "shared" {
  count = local.uses_shared_load_balancer ? 1 : 0

  # CloudFront connects only to this port; the shared ALB's other listeners stay VPC-only.
  vpc_origin_endpoint_config {
    name                   = local.name_prefix
    arn                    = var.shared_load_balancer.arn
    http_port              = 80
    https_port             = local.shared_listener_port
    origin_protocol_policy = "https-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }

  tags = local.common_tags
}

# CloudFront creates this service-managed group with the VPC's first VPC origin and attaches it to
# the origin ENIs. Admitting it, rather than the CloudFront origin-facing prefix list, limits the
# listener to this account's VPC origins.
data "aws_security_group" "cloudfront_vpc_origins" {
  count = local.uses_shared_load_balancer ? 1 : 0

  vpc_id = var.vpc_id

  filter {
    name   = "group-name"
    values = ["CloudFront-VPCOrigins-Service-SG"]
  }

  depends_on = [aws_cloudfront_vpc_origin.shared]
}

resource "aws_vpc_security_group_ingress_rule" "shared_alb_from_cloudfront" {
  count = local.uses_shared_load_balancer ? 1 : 0

  security_group_id            = var.shared_load_balancer.security_group_id
  referenced_security_group_id = data.aws_security_group.cloudfront_vpc_origins[0].id
  from_port                    = local.shared_listener_port
  to_port                      = local.shared_listener_port
  ip_protocol                  = "tcp"
}

resource "aws_acm_certificate" "edge" {
  count    = local.uses_shared_load_balancer ? 1 : 0
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"
  tags              = merge(local.common_tags, { Name = "${local.name_prefix}-edge" })

  lifecycle {
    create_before_destroy = true
  }
}

# ACM uses the same DNS validation record for a domain in every Region of an account, so the
# regional listener certificate's records also validate the CloudFront certificate.
resource "aws_acm_certificate_validation" "edge" {
  count    = local.uses_shared_load_balancer ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.edge[0].arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  count = local.uses_shared_load_balancer ? 1 : 0

  name = "Managed-CachingDisabled"
}

# Forwards every viewer header, including Authorization (the stream session token) and Host. The
# origin certificate covers domain_name, which CloudFront verifies against the forwarded Host.
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  count = local.uses_shared_load_balancer ? 1 : 0

  name = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "edge" {
  count = local.uses_shared_load_balancer ? 1 : 0

  aliases         = [var.domain_name]
  comment         = "Stream gateway"
  enabled         = true
  http_version    = "http2and3"
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"

  origin {
    domain_name = var.shared_load_balancer.dns_name
    origin_id   = local.name_prefix

    # Long-poll reads return within 20 s and Durable Streams closes idle SSE reads after 50 s
    # (apps/durable-streams/Caddyfile), both inside the 60 s maximum read timeout.
    vpc_origin_config {
      vpc_origin_id       = aws_cloudfront_vpc_origin.shared[0].id
      origin_read_timeout = 60
    }
  }

  # Every read is per-session and live, so nothing is cached or compressed at the edge.
  default_cache_behavior {
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled[0].id
    compress                 = false
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer[0].id
    target_origin_id         = local.name_prefix
    viewer_protocol_policy   = "https-only"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.edge[0].certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  # DNS moves to the distribution only once the origin listener admits CloudFront.
  depends_on = [aws_lb_listener.https, aws_vpc_security_group_ingress_rule.shared_alb_from_cloudfront]

  tags = merge(local.common_tags, { Name = var.domain_name })
}

resource "aws_route53_record" "edge_ipv6" {
  count = local.uses_shared_load_balancer ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    evaluate_target_health = false
    name                   = aws_cloudfront_distribution.edge[0].domain_name
    zone_id                = aws_cloudfront_distribution.edge[0].hosted_zone_id
  }
}
