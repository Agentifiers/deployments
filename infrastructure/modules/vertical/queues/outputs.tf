output "arns" {
  value = { for name, queue in aws_sqs_queue.this : name => queue.arn }
}

output "dlq_arns" {
  value = { for name, queue in aws_sqs_queue.dlq : name => queue.arn }
}

output "dlq_urls" {
  value = { for name, queue in aws_sqs_queue.dlq : name => queue.url }
}

output "urls" {
  value = { for name, queue in aws_sqs_queue.this : name => queue.url }
}

output "names" {
  value = { for name, queue in aws_sqs_queue.this : name => queue.name }
}

output "dlq_names" {
  value = { for name, queue in aws_sqs_queue.dlq : name => queue.name }
}

