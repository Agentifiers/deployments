module "document_extraction" {
  source = "../document-extraction"

  artifact_bucket       = var.document_extraction_artifact_bucket
  artifact_key          = var.document_extraction_artifact_key
  artifact_version      = var.document_extraction_artifact_version
  environment           = var.environment
  log_retention_in_days = var.operations.log_retention_days
  network = var.agent_runtime_enabled ? {
    private_subnet_ids = module.platform_network[0].private_subnet_ids
    s3_prefix_list_id  = module.platform_network[0].s3_prefix_list_id
    vpc_id             = module.platform_network[0].vpc_id
  } : null
  ocr_enabled              = var.document_extraction_ocr_enabled
  permissions_boundary_arn = var.iam_permissions_boundary_arn
  tags                     = var.tags
}
