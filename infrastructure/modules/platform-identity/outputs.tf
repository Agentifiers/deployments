output "api_audience" { value = var.resource_audience }
output "api_function_arn" { value = aws_lambda_function.api.arn }
output "endpoint" { value = local.issuer }
output "federation_kms_key_arn" { value = local.federation_key_arn }
output "issuer" { value = local.issuer }
output "jwks_uri" { value = "${local.issuer}/.well-known/jwks.json" }
output "signing_key_arn" { value = local.signing_key_arn }
output "principal_status_function_arn" { value = aws_lambda_function.principal_status.arn }
output "principal_status_function_name" { value = aws_lambda_function.principal_status.function_name }
output "client_bootstrap" {
  value = {
    additional_clients = {
      for id, client in var.additional_clients : id => {
        allowed_scopes = client.allowed_scopes
        name           = client.name
        redirect_uris  = client.redirect_uris
        secret_arn     = "${local.parameter_arn_prefix}/${local.name}/${id}-oauth-client"
      }
    }
    bootstrap_role_arn     = aws_iam_role.client_bootstrap.arn
    cli_redirect_uris      = var.cli_redirect_uris
    completion_marker_name = local.client_bootstrap_marker_name
    e2e_client_secret_arn  = local.e2e_client_secret_arn
    publication_ready      = trimspace(var.route53_zone_id) != ""
    web_client_secret_arn  = local.web_client_secret_arn
    web_redirect_uris      = var.web_redirect_uris
  }
}
output "function_arns" {
  value = {
    api                 = aws_lambda_function.api.arn
    email_dispatcher    = aws_lambda_function.dispatcher.arn
    email_reconciler    = aws_lambda_function.reconciler.arn
    email_worker        = aws_lambda_function.worker.arn
    principal_status    = aws_lambda_function.principal_status.arn
    public_email_worker = aws_lambda_function.public_email_worker.arn
  }
}
