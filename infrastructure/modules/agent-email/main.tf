locals {
  name_prefix         = "agent-email"
  runtime_name_prefix = "agent-email"
  raw_prefix          = "raw/"
  runtime_configured = (
    var.enable_runtime &&
    trimspace(var.runtime_artifact_bucket) != "" &&
    trimspace(var.runtime_artifact_key) != "" &&
    trimspace(var.runtime_artifact_version) != ""
  )
  inbound_runtime_configured = (
    local.runtime_configured &&
    var.enable_inbound_runtime
  )
  regional_ses_dkim_regions = toset([
    "af-south-1",
    "ap-northeast-3",
    "ap-south-2",
    "ap-southeast-3",
    "ap-southeast-5",
    "ca-west-1",
    "eu-central-2",
    "eu-south-1",
    "il-central-1",
    "me-central-1",
    "us-gov-east-1",
  ])
  dkim_domain = contains(local.regional_ses_dkim_regions, var.region) ? "dkim.${var.region}.amazonses.com" : "dkim.amazonses.com"
  tags = merge(
    {
      DataClassification = "customer-email"
      Environment        = var.environment
      ManagedBy          = "terraform"
      Product            = "deployments-ai-platform"
    },
    var.tags,
  )
  queue_names = toset(["events", "inbound", "maintenance", "send"])
  queue_visibility_timeouts = {
    events      = 360
    inbound     = 900
    maintenance = 900
    send        = 900
  }
  worker_queue_permissions = {
    events      = ["events"]
    inbound     = ["inbound", "send"]
    maintenance = ["maintenance"]
    send        = ["send"]
  }
  worker_function_names = {
    for key, arn in var.lambda_function_arns : key => element(split(":", arn), 6)
  }
  inbound_worker_configured = local.inbound_runtime_configured || (
    trimspace(lookup(var.lambda_function_arns, "inbound", "")) != "" &&
    trimspace(lookup(var.lambda_role_names, "inbound", "")) != "" &&
    trimspace(var.agent_run_queue_arn) != "" &&
    trimspace(var.agent_run_queue_url) != ""
  )
  send_worker_configured = local.runtime_configured || trimspace(lookup(var.lambda_function_arns, "send", "")) != ""
}

data "aws_partition" "current" {}
