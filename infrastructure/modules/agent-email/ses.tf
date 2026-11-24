resource "aws_ses_domain_identity" "email" {
  domain = var.domain
}

resource "aws_ses_domain_dkim" "email" {
  domain = aws_ses_domain_identity.email.domain
}

resource "aws_ses_domain_mail_from" "email" {
  domain                 = aws_ses_domain_identity.email.domain
  mail_from_domain       = "bounce.${var.domain}"
  behavior_on_mx_failure = "UseDefaultValue"
}

resource "aws_route53_record" "identity_verification" {
  count = var.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = "_amazonses.${var.domain}"
  type    = "TXT"
  records = [aws_ses_domain_identity.email.verification_token]
  ttl     = 60
}

resource "aws_route53_record" "dkim" {
  count = var.manage_dns ? 3 : 0

  zone_id = var.route53_zone_id
  name    = "${aws_ses_domain_dkim.email.dkim_tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  records = ["${aws_ses_domain_dkim.email.dkim_tokens[count.index]}.${local.dkim_domain}"]
  ttl     = 60
}

resource "aws_route53_record" "inbound_mx" {
  count = var.manage_dns && var.activate_receipt_rule_set && var.enable_catch_all_receiving ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain
  type    = "MX"
  records = ["10 inbound-smtp.${var.region}.amazonaws.com"]
  ttl     = 60

  depends_on = [
    aws_lambda_event_source_mapping.managed_inbound,
    aws_lambda_event_source_mapping.queue,
  ]
}

resource "aws_route53_record" "mail_from_mx" {
  count = var.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = "bounce.${var.domain}"
  type    = "MX"
  records = ["10 feedback-smtp.${var.region}.amazonses.com"]
  ttl     = 60
}

resource "aws_route53_record" "mail_from_spf" {
  count = var.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = "bounce.${var.domain}"
  type    = "TXT"
  records = ["v=spf1 include:amazonses.com -all"]
  ttl     = 60
}

resource "aws_ses_receipt_rule_set" "email" {
  rule_set_name = local.name_prefix

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_ses_active_receipt_rule_set" "email" {
  count = var.activate_receipt_rule_set ? 1 : 0

  rule_set_name = aws_ses_receipt_rule_set.email.rule_set_name
  depends_on = [
    aws_s3_bucket_server_side_encryption_configuration.email,
    aws_s3_bucket_versioning.email,
    aws_ses_receipt_rule.email,
    aws_sns_topic_subscription.inbound,
    aws_sqs_queue_policy.sns,
    aws_lambda_event_source_mapping.managed_inbound,
    aws_lambda_event_source_mapping.queue,
  ]

  lifecycle {
    precondition {
      condition     = var.enable_catch_all_receiving && local.inbound_worker_configured
      error_message = "Agent email receipt-rule-set activation requires catch-all receiving and a configured inbound worker ARN and role."
    }
  }
}

resource "aws_ses_receipt_rule" "email" {
  name          = local.name_prefix
  rule_set_name = aws_ses_receipt_rule_set.email.rule_set_name
  enabled       = true
  recipients    = []
  scan_enabled  = true
  tls_policy    = "Optional"

  s3_action {
    bucket_name       = aws_s3_bucket.email.id
    object_key_prefix = local.raw_prefix
    position          = 1
    topic_arn         = aws_sns_topic.inbound.arn
  }

  depends_on = [
    aws_s3_bucket_policy.email,
    aws_sns_topic_policy.email,
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_sesv2_configuration_set" "email" {
  configuration_set_name = local.name_prefix

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }
}

resource "aws_sesv2_account_suppression_attributes" "email" {
  count = var.disable_account_suppression ? 1 : 0

  suppressed_reasons = []
}

resource "terraform_data" "hosted_send_suppression_isolation" {
  input = try(one(aws_sesv2_account_suppression_attributes.email[*].id), null)

  lifecycle {
    precondition {
      condition     = !var.enable_runtime || local.runtime_configured
      error_message = "enable_runtime=true requires immutable runtime_artifact_bucket, runtime_artifact_key, and runtime_artifact_version values."
    }

    precondition {
      condition     = !local.send_worker_configured || var.disable_account_suppression
      error_message = "Agent-email send workers require disable_account_suppression=true so provider-managed hosted domains cannot inherit a cross-tenant SES account suppression list."
    }
  }
}

resource "aws_sesv2_configuration_set_event_destination" "email" {
  configuration_set_name = aws_sesv2_configuration_set.email.configuration_set_name
  event_destination_name = "agent-email-events"

  event_destination {
    enabled = true
    matching_event_types = [
      "BOUNCE",
      "COMPLAINT",
      "DELIVERY",
      "DELIVERY_DELAY",
      "REJECT",
      "RENDERING_FAILURE",
      "SEND",
    ]

    sns_destination {
      topic_arn = aws_sns_topic.events.arn
    }
  }

  depends_on = [aws_sns_topic_policy.email]
}
