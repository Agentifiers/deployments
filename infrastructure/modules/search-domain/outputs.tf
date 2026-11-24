output "arn" {
  description = "OpenSearch domain ARN; append /<index-pattern> to scope es:ESHttp* permissions."
  value       = aws_opensearch_domain.this.arn
}

output "endpoint" {
  description = "HTTPS origin of the OpenSearch domain endpoint."
  value       = "https://${aws_opensearch_domain.this.endpoint}"
}
