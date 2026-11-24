locals {
  # ECS services the operator console reports on. Enablement flags are plan-time known, so the
  # list shape is stable even while cluster ARNs are still being created.
  system_ecs_services = concat(
    var.model_runtime_enabled ? [{
      component    = "model-runtime"
      cluster_arn  = module.model_runtime[0].ecs_cluster_arn
      service_name = module.model_runtime[0].service_name
    }] : [],
    var.durable_streams_enabled ? [{
      component    = "durable-streams"
      cluster_arn  = module.durable_streams[0].cluster_arn
      service_name = module.durable_streams[0].service_name
    }] : [],
    var.agent_observability_hot_enabled ? [{
      component    = "observability-hot-plane"
      cluster_arn  = module.agent_observability_hot[0].cluster_arn
      service_name = module.agent_observability_hot[0].service_name
    }] : [],
    var.web_tools_runtime_enabled ? [{
      component    = "web-tools"
      cluster_arn  = module.web_tools_runtime[0].cluster_arn
      service_name = module.web_tools_runtime[0].service_name
    }] : [],
    var.web_tools_runtime_enabled ? [{
      component    = "web-tools-chromium"
      cluster_arn  = module.web_tools_runtime[0].cluster_arn
      service_name = module.web_tools_runtime[0].chromium_service_name
    }] : [],
    var.agent_runtime_enabled ? [{
      component    = "stream-gateway"
      cluster_arn  = module.stream_gateway[0].cluster_arn
      service_name = module.stream_gateway[0].service_name
    }] : [],
    var.agent_runtime_enabled ? [{
      component    = "agent-worker"
      cluster_arn  = module.agent_runtime[0].worker_cluster_arn
      service_name = module.agent_runtime[0].worker_service_name
    }] : [],
  )

  # Provider keys are SecureString parameters; the API reads only their metadata.
  system_model_provider_secret_arns = var.model_runtime_enabled ? {
    for provider in ["openai", "openrouter"] : provider => module.model_runtime[0].secret_arns["${provider}-api-key"]
    if contains(keys(module.model_runtime[0].secret_arns), "${provider}-api-key")
  } : {}

  system_observability = var.agent_observability_history_enabled ? {
    athena_workgroup       = module.agent_observability[0].athena_workgroup_name
    history_retention_days = var.operations.observability_retention_days
    table_bucket           = module.platform_data.agent_observability_table_bucket_name
    table_namespace        = module.platform_data.agent_observability_table_namespace
  } : null
}

output "platform_identity_issuer" {
  description = "Published platform identity issuer, or null before the identity domain is published."
  value       = local.platform_identity_published ? local.platform_identity_issuer : null
}
