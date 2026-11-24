output "connected" {
  description = "Whether the ops alerts topic reaches anyone (an email subscription or a Slack channel), so platform modules create their alarms."
  value       = local.connected
}

output "slack_bot_token_parameter_name" {
  description = "SSM SecureString holding the ops alerts Slack bot token; the placeholder value pending leaves Slack delivery unconfigured."
  value       = aws_ssm_parameter.slack_bot_token.name
}

output "topic_arn" {
  description = "SNS topic that every platform CloudWatch alarm notifies on ALARM and OK."
  value       = aws_sns_topic.ops_alerts.arn
}
