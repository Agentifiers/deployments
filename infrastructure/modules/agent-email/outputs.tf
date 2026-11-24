output "bucket_arn" {
  value = aws_s3_bucket.email.arn
}

output "bucket_name" {
  value = aws_s3_bucket.email.id
}

output "api_function_arn" {
  description = "Hosted agent-email API Lambda ARN, or null when no runtime artifact is configured."
  value       = try(aws_lambda_function.api[0].arn, null)
}

output "api_function_name" {
  description = "Hosted agent-email API Lambda function name, or null when no runtime artifact is configured."
  value       = try(aws_lambda_function.api[0].function_name, null)
}

output "api_invoke_arn" {
  description = "Hosted agent-email API Lambda invoke ARN, or null when no runtime artifact is configured."
  value       = try(aws_lambda_function.api[0].invoke_arn, null)
}

output "configuration_set_name" {
  value = aws_sesv2_configuration_set.email.configuration_set_name
}

output "dns_records" {
  value = {
    dkim = [for token in aws_ses_domain_dkim.email.dkim_tokens : {
      name  = "${token}._domainkey.${var.domain}"
      type  = "CNAME"
      value = "${token}.${local.dkim_domain}"
    }]
    identity = {
      name  = "_amazonses.${var.domain}"
      type  = "TXT"
      value = aws_ses_domain_identity.email.verification_token
    }
    inbound_mx = {
      name     = var.domain
      priority = 10
      type     = "MX"
      value    = "inbound-smtp.${var.region}.amazonaws.com"
    }
    mail_from_mx = {
      name     = "bounce.${var.domain}"
      priority = 10
      type     = "MX"
      value    = "feedback-smtp.${var.region}.amazonses.com"
    }
    mail_from_spf = {
      name  = "bounce.${var.domain}"
      type  = "TXT"
      value = "v=spf1 include:amazonses.com -all"
    }
  }
}

output "events_topic_arn" {
  value = aws_sns_topic.events.arn
}

output "inbound_processing_ready" {
  value = (
    var.activate_receipt_rule_set &&
    var.enable_catch_all_receiving &&
    (
      try(aws_lambda_event_source_mapping.managed_inbound[0].uuid != "", false) ||
      try(aws_lambda_event_source_mapping.queue["inbound"].uuid != "", false)
    )
  )
}

output "inbound_role_arns" {
  description = "Roles that run inbound email, the managed inbound Lambda's and an externally supplied inbound worker's. The ingress attachment capture role trusts them."
  value       = local.inbound_role_arns
}

output "inbound_function_arn" {
  description = "Managed inbound agent-email Lambda ARN, or null when canonical workflow queue wiring is unavailable."
  value       = try(aws_lambda_function.inbound[0].arn, null)
}

output "maintenance_trigger_configured" {
  description = "Whether managed maintenance has a safe bounded global trigger."
  value       = try(aws_scheduler_schedule.managed_maintenance[0].arn != "", false)
}

output "managed_worker_function_arns" {
  description = "Managed send, provider-event, stream-dispatcher, and maintenance Lambda ARNs."
  value       = { for key, function in aws_lambda_function.managed_worker : key => function.arn }
}

output "queue_arns" {
  value = merge(
    { for key, queue in aws_sqs_queue.worker : key => queue.arn },
    { stream-dispatcher-dlq = aws_sqs_queue.stream_dispatcher_dlq.arn },
  )
}

output "queue_urls" {
  value = merge(
    { for key, queue in aws_sqs_queue.worker : key => queue.url },
    { stream-dispatcher-dlq = aws_sqs_queue.stream_dispatcher_dlq.url },
  )
}

output "raw_prefix" {
  value = local.raw_prefix
}

output "regional_event_topic_kms_key_arns" {
  value = merge(var.regional_event_topic_kms_key_arns, { (var.region) = var.data_kms_key_arn })
}

output "worker_policy_arns" {
  value = { for key, policy in aws_iam_policy.worker : key => policy.arn }
}
