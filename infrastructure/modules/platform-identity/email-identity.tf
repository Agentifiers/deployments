resource "aws_ses_domain_identity" "identity" {
  domain = local.email_domain
}

resource "aws_ses_domain_dkim" "identity" {
  domain = aws_ses_domain_identity.identity.domain
}

resource "aws_route53_record" "identity_email_verification" {
  count = trimspace(var.route53_zone_id) != "" ? 1 : 0

  allow_overwrite = true
  name            = "_amazonses.${local.email_domain}"
  records         = [aws_ses_domain_identity.identity.verification_token]
  ttl             = 60
  type            = "TXT"
  zone_id         = var.route53_zone_id
}

resource "aws_route53_record" "identity_email_dkim" {
  count = trimspace(var.route53_zone_id) != "" ? 3 : 0

  allow_overwrite = true
  name            = "${aws_ses_domain_dkim.identity.dkim_tokens[count.index]}._domainkey.${local.email_domain}"
  records         = ["${aws_ses_domain_dkim.identity.dkim_tokens[count.index]}.dkim.amazonses.com"]
  ttl             = 60
  type            = "CNAME"
  zone_id         = var.route53_zone_id
}

resource "aws_ses_domain_identity_verification" "identity" {
  count = trimspace(var.route53_zone_id) != "" ? 1 : 0

  domain     = aws_ses_domain_identity.identity.id
  depends_on = [aws_route53_record.identity_email_verification]
}
