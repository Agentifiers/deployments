resource "aws_iam_service_linked_role" "opensearch" {
  aws_service_name = "opensearchservice.amazonaws.com"
}

locals {
  # OpenSearch domain serving each enabled search runtime: one shared "search"
  # domain, or an isolated domain named after the runtime. IAM scopes each
  # runtime to its own index prefix (memory-*, brain-*) in either layout.
  search_domain_for = {
    for runtime, enabled in {
      brain  = var.platform_api_enabled && var.agent_runtime_enabled
      memory = var.memory_runtime_enabled
    } : runtime => var.operations.shared_search_domain ? "search" : runtime if enabled
  }
}

module "search_domain" {
  for_each = toset(values(local.search_domain_for))
  source   = "../search-domain"

  domain_name    = each.key
  environment    = var.environment
  instance_count = var.opensearch_instance_count
  instance_type  = var.opensearch_instance_type
  network        = local.private_network
  tags           = var.tags
  volume_size    = var.opensearch_volume_size

  depends_on = [aws_iam_service_linked_role.opensearch]
}

module "memory_runtime" {
  count  = var.memory_runtime_enabled ? 1 : 0
  source = "../memory-runtime"

  alarms_enabled = module.ops_alerts.connected

  alarm_topic_arn                        = module.ops_alerts.topic_arn
  aws_native_enabled                     = true
  artifact_bucket                        = var.memory_runtime_artifact_bucket
  artifact_key                           = var.memory_runtime_artifact_key
  artifact_version                       = var.memory_runtime_artifact_version
  blob_bucket_arn                        = module.platform_data.artifact_bucket_arn
  blob_bucket_name                       = module.platform_data.artifact_bucket_name
  legacy_blob_bucket_arns                = local.legacy_artifact_bucket_arns
  legacy_blob_bucket_names               = local.legacy_artifact_bucket_names
  data_kms_key_arn                       = module.platform_data.kms_key_arn
  default_model_spend_ceiling_usd_micros = var.default_model_spend_ceiling_usd_micros
  dynamodb_table_arns                    = local.shared_runtime_table_arns
  dynamodb_table_names                   = local.shared_runtime_table_names
  embedding_model                        = var.memory_runtime_embedding_model
  environment                            = var.environment
  event_bus_name                         = module.platform_events[0].event_bus_name
  flush_model                            = var.memory_runtime_flush_model
  index_worker_maximum_concurrency       = var.memory_runtime_index_worker_maximum_concurrency
  jwt_audience                           = local.memory_jwt_audiences
  jwt_issuer                             = local.memory_jwt_issuer
  jwt_jwks_uri                           = local.memory_jwt_jwks_uri
  log_retention_in_days                  = var.operations.log_retention_days
  membership_keyring                     = var.memory_runtime_membership_keyring
  model_gateway_base_url                 = module.model_runtime[0].model_gateway_base_url
  model_gateway_fallback_ids             = var.model_gateway_service_fallback_model_ids
  model_gateway_token_issuer             = module.agent_runtime[0].model_token_issuers["memory"]
  network                                = local.private_network
  opensearch_domain_arn                  = module.search_domain[local.search_domain_for["memory"]].arn
  opensearch_endpoint                    = module.search_domain[local.search_domain_for["memory"]].endpoint
  permissions_boundary_arn               = var.iam_permissions_boundary_arn
  reconciliation_scopes                  = var.memory_runtime_reconciliation_scopes
  request_admission_table_arn            = module.platform_data.request_admission_table_arn
  request_admission_table_name           = module.platform_data.request_admission_table_name
  rerank_model                           = var.memory_runtime_rerank_model
  tags                                   = var.tags
  tenant_limit_defaults_json             = jsonencode(var.operations.tenant_limit_defaults)
}

module "brain_runtime" {
  count  = var.platform_api_enabled && var.agent_runtime_enabled ? 1 : 0
  source = "../brain-runtime"

  alarms_enabled = module.ops_alerts.connected

  alarm_topic_arn                  = module.ops_alerts.topic_arn
  answer_model                     = var.brain_runtime_answer_model
  artifact_bucket                  = var.platform_api_artifact_bucket
  artifact_key                     = var.platform_api_artifact_key
  artifact_version                 = var.platform_api_artifact_version
  aws_native_enabled               = true
  model_gateway_base_url           = module.model_runtime[0].model_gateway_base_url
  model_gateway_fallback_ids       = var.model_gateway_service_fallback_model_ids
  model_gateway_token_issuer       = module.agent_runtime[0].model_token_issuers["brain"]
  content_bucket_arn               = module.platform_data.artifact_bucket_arn
  content_bucket_name              = module.platform_data.artifact_bucket_name
  legacy_content_bucket_arns       = local.legacy_artifact_bucket_arns
  legacy_content_bucket_names      = local.legacy_artifact_bucket_names
  data_kms_key_arn                 = module.platform_data.kms_key_arn
  document_extraction_function     = { arn = module.document_extraction.function_arn, function_name = module.document_extraction.function_name }
  dynamodb_table_arns              = local.shared_runtime_table_arns
  dynamodb_table_names             = local.shared_runtime_table_names
  environment                      = var.environment
  event_bus_name                   = module.platform_events[0].event_bus_name
  index_worker_maximum_concurrency = var.brain_runtime_index_worker_maximum_concurrency
  log_retention_in_days            = var.operations.log_retention_days
  memory_erasure_function_arn      = module.memory_runtime[0].erasure_function_arn
  memory_erasure_function_name     = module.memory_runtime[0].erasure_function_name
  opensearch_domain_arn            = module.search_domain[local.search_domain_for["brain"]].arn
  opensearch_endpoint              = module.search_domain[local.search_domain_for["brain"]].endpoint
  permissions_boundary_arn         = var.iam_permissions_boundary_arn
  private_subnet_ids               = module.platform_network[0].private_subnet_ids
  tags                             = var.tags
  upload_quotas                    = var.brain_runtime_upload_quotas
  vpc_id                           = module.platform_network[0].vpc_id
}
