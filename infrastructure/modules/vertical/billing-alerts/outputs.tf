output "anomaly_monitor_arn" {
  description = "ARN of the account service cost anomaly monitor."
  value       = aws_ce_anomaly_monitor.services.arn
}

output "daily_budget_name" {
  description = "Name of the daily account cost budget."
  value       = aws_budgets_budget.daily.name
}

output "immediate_alert_topic_arn" {
  description = "SNS topic used for immediate cost anomaly alerts."
  value       = aws_sns_topic.immediate_anomalies.arn
}

output "monthly_budget_name" {
  description = "Name of the monthly account cost budget."
  value       = aws_budgets_budget.monthly.name
}
