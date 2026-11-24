resource "aws_security_group" "service" {
  name_prefix = "${local.name_prefix}-service-"
  description = "Minimal private Firecrawl task"
  vpc_id      = var.vpc_id
  tags        = local.common_tags
}

resource "aws_security_group" "public_http" {
  name_prefix = "${local.name_prefix}-http-"
  description = "Public IPv4 HTTP egress with private and reserved ranges excluded"
  vpc_id      = var.vpc_id
  tags        = local.common_tags
}

resource "aws_security_group" "public_https" {
  name_prefix = "${local.name_prefix}-https-"
  description = "Public IPv4 HTTPS egress with private and reserved ranges excluded"
  vpc_id      = var.vpc_id
  tags        = local.common_tags
}

resource "aws_security_group" "chromium" {
  name_prefix = "${local.chromium_name}-"
  description = "Private Chromium fallback renderer task reachable only from Firecrawl"
  vpc_id      = var.vpc_id
  tags        = local.common_tags
}

resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  security_group_id            = aws_security_group.service.id
  referenced_security_group_id = var.load_balancer_security_group_id
  from_port                    = 3002
  to_port                      = 3002
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "service_to_model_gateway" {
  security_group_id            = aws_security_group.service.id
  referenced_security_group_id = var.load_balancer_security_group_id
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "service_dns_tcp" {
  security_group_id = aws_security_group.service.id
  cidr_ipv4         = "${cidrhost(data.aws_vpc.runtime.cidr_block, 2)}/32"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "service_dns_udp" {
  security_group_id = aws_security_group.service.id
  cidr_ipv4         = "${cidrhost(data.aws_vpc.runtime.cidr_block, 2)}/32"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
}

resource "aws_vpc_security_group_egress_rule" "service_to_chromium" {
  security_group_id            = aws_security_group.service.id
  referenced_security_group_id = aws_security_group.chromium.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "chromium_from_service" {
  security_group_id            = aws_security_group.chromium.id
  referenced_security_group_id = aws_security_group.service.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "chromium_dns_tcp" {
  security_group_id = aws_security_group.chromium.id
  cidr_ipv4         = "${cidrhost(data.aws_vpc.runtime.cidr_block, 2)}/32"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "chromium_dns_udp" {
  security_group_id = aws_security_group.chromium.id
  cidr_ipv4         = "${cidrhost(data.aws_vpc.runtime.cidr_block, 2)}/32"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
}

resource "aws_vpc_security_group_egress_rule" "public_http" {
  for_each = toset(local.task_egress_ipv4_cidrs)

  security_group_id = aws_security_group.public_http.id
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "public_https" {
  for_each = toset(local.task_egress_ipv4_cidrs)

  security_group_id = aws_security_group.public_https.id
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_acm_certificate" "firecrawl" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(local.common_tags, { Name = var.domain_name })
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.firecrawl.domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "firecrawl" {
  certificate_arn         = aws_acm_certificate.firecrawl.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_lb_target_group" "firecrawl" {
  name_prefix          = "web-"
  port                 = 3002
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    enabled             = true
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200"
    path                = "/v0/health/liveness"
    timeout             = 10
    unhealthy_threshold = 5
  }

  tags = local.common_tags
}

resource "aws_lb_listener" "firecrawl" {
  load_balancer_arn = var.load_balancer_arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = aws_acm_certificate_validation.firecrawl.certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.firecrawl.arn
  }

  tags = local.common_tags
}

resource "aws_route53_record" "firecrawl" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = var.load_balancer_dns_name
    zone_id                = var.load_balancer_zone_id
    evaluate_target_health = true
  }
}
