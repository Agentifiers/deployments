resource "aws_acm_certificate" "identity" {
  count = var.publish_domain && trimspace(var.certificate_arn) == "" && trimspace(var.route53_zone_id) != "" ? 1 : 0

  domain_name       = var.domain_name
  validation_method = "DNS"
  tags              = merge(local.tags, { Name = "${local.name}-certificate" })

  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "identity_certificate_validation" {
  for_each = var.publish_domain && trimspace(var.certificate_arn) == "" && trimspace(var.route53_zone_id) != "" ? {
    for option in aws_acm_certificate.identity[0].domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "identity" {
  count = var.publish_domain && trimspace(var.certificate_arn) == "" && trimspace(var.route53_zone_id) != "" ? 1 : 0

  certificate_arn         = aws_acm_certificate.identity[0].arn
  validation_record_fqdns = [for record in aws_route53_record.identity_certificate_validation : record.fqdn]
}
