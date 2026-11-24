# The real providers plan this root offline, so resource attributes stay unknown at plan as in
# an account with no prior state: a count or for_each that waits on one fails here the way a
# first deploy would. The AWS provider plans each certificate's validation domain names, so
# validation records key their for_each on them exactly as in a real plan.
#
# The credentials are fake. Every data source a plan reads is overridden below; a new one
# fails the test with an AWS API error until it is overridden here too.
provider "aws" {
  region                      = "us-east-2"
  access_key                  = "test"
  secret_key                  = "test"
  max_retries                 = 1
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  skip_requesting_account_id  = true

  default_tags {
    tags = { Environment = "acme" }
  }
}

provider "aws" {
  alias                       = "us_east_1"
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  max_retries                 = 1
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  skip_requesting_account_id  = true

  default_tags {
    tags = { Environment = "acme" }
  }
}

override_data {
  target = module.platform.module.agent_observability.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.platform.module.agent_observability_hot.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.platform.module.agent_runtime.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.platform.module.console.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.platform.module.event_analytics.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.platform.module.model_runtime.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.platform.module.ops_alerts.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.platform.module.platform_data.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.platform.module.platform_events.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.platform.module.platform_identity.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.platform.module.sandbox_runtime.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.platform.module.agent_observability_hot.data.aws_kms_key.ebs_managed
  values = { arn = "arn:aws:kms:us-east-2:123456789012:key/00000000-0000-4000-8000-000000000006" }
}

override_data {
  target = module.platform.module.agent_observability_hot.data.aws_ami.ubuntu_arm64
  values = { id = "ami-0fedcba9876543210" }
}

override_data {
  target = module.platform.module.agent_observability_hot.data.aws_ebs_volumes.existing_data
  values = { ids = [] }
}

override_data {
  target = module.platform.module.console.data.aws_cloudfront_cache_policy.caching_disabled
  values = {}
}

override_data {
  target = module.platform.module.console.data.aws_cloudfront_cache_policy.caching_optimized
  values = {}
}

override_data {
  target = module.platform.module.console.data.aws_cloudfront_origin_request_policy.all_viewer_except_host
  values = {}
}

override_data {
  target = module.platform.module.console.data.aws_cloudfront_response_headers_policy.security_headers
  values = {}
}

override_data {
  target = module.platform.module.stream_gateway.data.aws_cloudfront_cache_policy.caching_disabled
  values = {}
}

override_data {
  target = module.platform.module.stream_gateway.data.aws_cloudfront_origin_request_policy.all_viewer
  values = {}
}

override_data {
  target = module.platform.data.aws_ssm_parameters_by_path.event_analytics_lifecycle
  values = { names = [] }
}

override_data {
  target = data.aws_ami.fck_nat
  values = { id = "ami-0f0e0d0c0b0a09080" }
}

override_data {
  target = module.platform.module.app_runtime.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.platform.module.app_runtime.data.aws_cloudfront_cache_policy.caching_disabled
  values = {}
}

override_data {
  target = module.platform.module.app_runtime.data.aws_cloudfront_origin_request_policy.all_viewer
  values = {}
}

variables {
  aws_account_id                   = "123456789012"
  aws_region                       = "us-east-2"
  platform_identity_publish_domain = false

  app_gateway_image               = "123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/app-gateway@sha256:8888888888888888888888888888888888888888888888888888888888888888"
  web_tools_firecrawl_image       = "123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/firecrawl@sha256:9999999999999999999999999999999999999999999999999999999999999999"
  web_tools_firecrawl_table       = jsondecode(file("../../../scripts/platform-deploy/firecrawl-table.fixture.json"))
  web_tools_proxy_image           = "123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/web-tools-proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  lambda_microvm_image_identifier = "arn:aws:lambda:us-east-2:123456789012:microvm-image:deployments-ai-sandbox"
  lambda_microvm_image_version    = "1"

  agent_worker_image            = "123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/agent-worker@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  bifrost_image                 = "123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/bifrost@sha256:7777777777777777777777777777777777777777777777777777777777777777"
  durable_streams_image         = "123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/durable-streams@sha256:2222222222222222222222222222222222222222222222222222222222222222"
  model_gateway_image           = "123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/model-gateway@sha256:3333333333333333333333333333333333333333333333333333333333333333"
  stream_gateway_image          = "123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/stream-gateway@sha256:4444444444444444444444444444444444444444444444444444444444444444"
  agent_observability_hot_image = "123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/observability-hot-plane@sha256:5555555555555555555555555555555555555555555555555555555555555555"

  agent_email_artifact_bucket                = "artifacts-123456789012"
  agent_email_artifact_key                   = "releases/sha256/a1/agent-email-runtime.zip"
  agent_email_artifact_version               = "v1"
  agent_runtime_artifact_bucket              = "artifacts-123456789012"
  agent_runtime_artifact_key                 = "releases/sha256/a2/agent-runtime.zip"
  agent_runtime_artifact_version             = "v1"
  app_domains_artifact_bucket                = "artifacts-123456789012"
  app_domains_artifact_key                   = "releases/sha256/b5/app-domains.zip"
  app_domains_artifact_version               = "v1"
  apps_database_artifact_bucket              = "artifacts-123456789012"
  apps_database_artifact_key                 = "releases/sha256/b4/apps-database.zip"
  apps_database_artifact_version             = "v1"
  channel_provider_artifact_bucket           = "artifacts-123456789012"
  channel_provider_artifact_key              = "releases/sha256/a3/channel-provider-runtime.zip"
  channel_provider_artifact_version          = "v1"
  console_artifact_bucket                    = "artifacts-123456789012"
  console_artifact_key                       = "releases/sha256/a4/console.zip"
  console_artifact_version                   = "v1"
  document_extraction_artifact_bucket        = "artifacts-123456789012"
  document_extraction_artifact_key           = "releases/sha256/a5/document-extraction.zip"
  document_extraction_artifact_version       = "v1"
  event_analytics_projector_artifact_bucket  = "artifacts-123456789012"
  event_analytics_projector_artifact_key     = "releases/sha256/b3/event-analytics-projector.zip"
  event_analytics_projector_artifact_version = "v1"
  event_dispatcher_artifact_bucket           = "artifacts-123456789012"
  event_dispatcher_artifact_key              = "releases/sha256/a6/event-dispatcher.zip"
  event_dispatcher_artifact_version          = "v1"
  platform_identity_api_artifact_bucket      = "artifacts-123456789012"
  platform_identity_api_artifact_key         = "releases/sha256/a7/identity-api.zip"
  platform_identity_api_artifact_version     = "v1"
  platform_identity_email_artifact_bucket    = "artifacts-123456789012"
  platform_identity_email_artifact_key       = "releases/sha256/a8/identity-email-worker.zip"
  platform_identity_email_artifact_version   = "v1"
  memory_runtime_artifact_bucket             = "artifacts-123456789012"
  memory_runtime_artifact_key                = "releases/sha256/a9/memory-runtime.zip"
  memory_runtime_artifact_version            = "v1"
  ops_alerts_notifier_artifact_bucket        = "artifacts-123456789012"
  ops_alerts_notifier_artifact_key           = "releases/sha256/b1/ops-alerts-notifier.zip"
  ops_alerts_notifier_artifact_version       = "v1"
  platform_api_artifact_bucket               = "artifacts-123456789012"
  platform_api_artifact_key                  = "releases/sha256/b2/platform-api.zip"
  platform_api_artifact_version              = "v1"
}

run "plans_every_default_feature_from_the_required_inputs_alone" {
  command = plan

  assert {
    condition = alltrue([
      var.platform_identity_enabled,
      var.platform_api_enabled,
      var.console_enabled,
      var.agent_runtime_enabled,
      var.channel_provider_runtime_enabled,
      var.memory_runtime_enabled,
      var.enable_platform_events,
      var.agent_email_enable_runtime,
      var.agent_email_activate_receipt_rule_set,
      var.agent_email_manage_dns,
      var.agent_runtime_web_tools_enabled,
      var.web_tools_runtime_enabled,
      var.sandbox_lambda_microvm_enabled,
      var.agent_observability_history_enabled,
      var.agent_observability_hot_enabled,
      var.bifrost_desired_count > 0,
      var.durable_streams_desired_count > 0,
    ])
    error_message = "A fresh install must turn on every feature that needs no operator-specific input."
  }

  assert {
    condition = alltrue([
      !var.platform_identity_registration_enabled,
      !var.apps_enabled,
      !var.document_extraction_ocr_enabled,
    ])
    error_message = "Self-registration, apps, and document OCR need an operator's decision and must stay off by default."
  }

  assert {
    condition = (
      var.event_analytics_lifecycle == "running" &&
      output.event_analytics_athena.workgroup_name == "semantic-events" &&
      output.event_analytics_athena.catalog_name == "s3tablescatalog/semantic-events" &&
      output.event_analytics_athena.database_name == "semantic_events" &&
      output.event_analytics_athena.table_name == "events"
    )
    error_message = "A fresh install must run event analytics and expose its Athena coordinates to operator tooling."
  }

  assert {
    condition = (
      output.sandbox_lambda_microvm_log_group_name == "/aws/lambda-microvms/deployments-ai-sandbox" &&
      output.web_tools_runtime != null &&
      output.app_runtime == null
    )
    error_message = "The default features must plan their runtimes."
  }

  assert {
    condition     = local.network_nat_mode == "instance" && length(terraform_data.nat_instance_ami) == 1
    error_message = "The in-stack web tools must egress through a NAT instance pinned to the fck-nat AMI resolved at the first apply."
  }

  assert {
    condition     = local.web_tools_domain_name == "web-tools.api.acme.example" && local.web_tools_route53_zone_id == "Z0ACME0EXAMPLE0ZONE"
    error_message = "The in-stack Firecrawl must default to a host under the API domain in the API zone."
  }

  assert {
    condition     = length(var.memory_runtime_reconciliation_scopes) == 0
    error_message = "The memory runtime must plan before any tenant exists."
  }

  assert {
    condition     = output.model_runtime_hosted_providers == tolist(["bedrock"]) && keys(output.model_runtime_secret_arns) == tolist(["model-grants-json"])
    error_message = "The default install must host Bedrock only and create no provider key parameter."
  }

  assert {
    condition = alltrue([
      for model in concat(
        [var.memory_runtime_embedding_model, var.memory_runtime_rerank_model, var.brain_runtime_answer_model, var.web_tools_firecrawl_model_name, var.web_tools_firecrawl_embedding_model_name],
        var.model_gateway_service_fallback_model_ids,
      ) : startswith(model, "bedrock/global.")
    ])
    error_message = "Every default service model must be a Bedrock global inference profile."
  }

  assert {
    condition     = local.default_tags == { Environment = "acme" }
    error_message = "Every resource must be tagged with the install's environment name only."
  }

  assert {
    condition     = module.billing_alerts.daily_budget_name == "platform-acme-billing-daily" && module.billing_alerts.monthly_budget_name == "platform-acme-billing-monthly"
    error_message = "Billing alert names must come from environment_name."
  }
}

# The deploy tool applies the sandbox prerequisites before it publishes the MicroVM image and the
# Lambda archives, so that targeted plan must succeed without either.
run "plans_the_lambda_microvm_prerequisites_before_release_artifacts_exist" {
  command = plan

  plan_options {
    target = [module.platform.module.sandbox_runtime[0]]
  }

  variables {
    lambda_microvm_image_identifier            = ""
    lambda_microvm_image_version               = ""
    event_analytics_projector_artifact_bucket  = ""
    event_analytics_projector_artifact_key     = ""
    event_analytics_projector_artifact_version = ""
    ops_alerts_notifier_artifact_bucket        = ""
    ops_alerts_notifier_artifact_key           = ""
    ops_alerts_notifier_artifact_version       = ""
    platform_api_artifact_bucket               = ""
    platform_api_artifact_key                  = ""
    platform_api_artifact_version              = ""
  }
}

run "rejects_service_models_on_a_provider_the_install_does_not_host" {
  command = plan

  variables {
    model_runtime_hosted_providers = ["openrouter"]
  }

  expect_failures = [
    var.memory_runtime_embedding_model,
    var.memory_runtime_rerank_model,
    var.brain_runtime_answer_model,
    var.model_gateway_service_fallback_model_ids,
    var.web_tools_firecrawl_model_name,
    var.web_tools_firecrawl_embedding_model_name,
  ]
}

run "rejects_a_flush_model_on_a_provider_the_install_does_not_host" {
  command = plan

  variables {
    memory_runtime_flush_model = "openrouter/anthropic/claude-haiku-4.5"
  }

  expect_failures = [var.memory_runtime_flush_model]
}

run "plans_an_install_flush_model" {
  command = plan

  variables {
    memory_runtime_flush_model = "bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0"
  }
}

run "rejects_a_flush_model_the_memory_issuer_admits_without_tenant_policy" {
  command = plan

  variables {
    memory_runtime_flush_model = "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"
  }

  expect_failures = [var.memory_runtime_flush_model]
}

run "rejects_the_rerank_model_as_flush_model_with_other_capitals_and_spaces" {
  command = plan

  variables {
    memory_runtime_flush_model = "bedrock/global.anthropic.claude-HAIKU-4-5-20251001-v1:0 "
  }

  expect_failures = [var.memory_runtime_flush_model]
}

run "requires_nat_instances_for_the_in_stack_web_tools" {
  command = plan

  variables {
    network_nat_mode = "gateway"
  }

  expect_failures = [var.web_tools_runtime_enabled]
}

run "requires_an_external_firecrawl_without_the_in_stack_runtime" {
  command = plan

  variables {
    web_tools_runtime_enabled = false
  }

  expect_failures = [var.agent_runtime_firecrawl_base_url, var.agent_runtime_firecrawl_job_ticket_secret_arn]
}

run "plans_web_tools_against_an_external_firecrawl_behind_nat_gateways" {
  command = plan

  variables {
    web_tools_runtime_enabled                     = false
    agent_runtime_firecrawl_base_url              = "https://firecrawl.acme.example"
    agent_runtime_firecrawl_api_key_secret_arn    = "arn:aws:secretsmanager:us-east-2:123456789012:secret:firecrawl-api-key-AbCdEf"
    agent_runtime_firecrawl_job_ticket_secret_arn = "arn:aws:secretsmanager:us-east-2:123456789012:secret:firecrawl-job-ticket-AbCdEf"
  }

  assert {
    condition     = output.web_tools_runtime == null
    error_message = "An external Firecrawl must not plan the in-stack runtime."
  }

  assert {
    condition     = local.network_nat_mode == "gateway" && length(data.aws_ami.fck_nat) == 0
    error_message = "Without the in-stack web tools, egress must default to managed NAT gateways."
  }
}

run "requires_the_agent_email_zone_while_the_stack_manages_its_records" {
  command = plan

  variables {
    agent_email_route53_zone_id = ""
  }

  expect_failures = [var.agent_email_route53_zone_id]
}

run "rejects_a_permissions_boundary_outside_the_install_account" {
  command = plan

  variables {
    iam_permissions_boundary_arn = "arn:aws:iam::210987654321:policy/platform-workload-boundary"
  }

  expect_failures = [var.iam_permissions_boundary_arn]
}

run "requires_a_pinned_bifrost_image_and_a_well_formed_clickhouse_ami" {
  command = plan

  variables {
    bifrost_image                         = "maximhq/bifrost:latest"
    agent_observability_clickhouse_ami_id = "ubuntu-noble-24.04"
  }

  expect_failures = [var.bifrost_image, var.agent_observability_clickhouse_ami_id]
}

run "plans_every_optional_feature_with_the_opposite_operations_posture" {
  command = plan

  variables {
    operations = {
      deletion_protection             = false
      secret_recovery_window_days     = 0
      kms_deletion_window_days        = 7
      high_availability               = false
      enhanced_monitoring             = false
      compact_sizing                  = true
      fargate_spot                    = true
      web_application_firewall        = false
      shared_search_domain            = true
      dedicated_public_load_balancers = false
      operator_shell_access           = true
      test_fixtures                   = true
      log_retention_days              = 30
      service_log_retention_days      = 7
      failure_retention_days          = 30
      query_result_retention_days     = 7
      observability_retention_days    = 30
      backup_retention_days           = 7
      webhook_delivery_retention_days = 7
      ops_alerts_slack_channel_id     = "C0ACMEOPS"
      ops_alerts_email                = "ops@acme.example"
      public_api_throttle             = { rate_limit = 50, burst_limit = 100 }
      tenant_limit_defaults = {
        api_requests_per_second = 10
        api_request_burst       = 20
        concurrent_runs         = 4
        active_sandboxes        = 4
      }
    }
    model_runtime_hosted_providers       = ["bedrock", "openai", "openrouter"]
    memory_runtime_reconciliation_scopes = [{ environment_id = "01JA0000000000000000000001", organization_id = "01JA0000000000000000000002", project_id = "01JA0000000000000000000003" }]

    platform_identity_publish_domain       = true
    platform_identity_registration_enabled = true

    apps_enabled         = true
    apps_domain          = "apps.acme.example"
    apps_route53_zone_id = "Z0ACME0EXAMPLE0ZONE"

    agent_runtime_browser_allowed_origins = ["https://www.acme.example"]

    agent_observability_clickhouse_ami_id = "ami-0123456789abcdef0"

    event_analytics_lifecycle                  = "running"
    event_analytics_projector_artifact_bucket  = "artifacts-123456789012"
    event_analytics_projector_artifact_key     = "releases/sha256/b3/event-analytics-projector.zip"
    event_analytics_projector_artifact_version = "v1"
  }

  assert {
    condition     = output.app_runtime != null
    error_message = "Apps must plan once a domain is chosen."
  }

  assert {
    condition     = keys(output.model_runtime_secret_arns) == tolist(["model-grants-json", "openai-api-key", "openrouter-api-key"])
    error_message = "Hosting OpenAI and OpenRouter must plan their key parameters."
  }
}

# Assertions cannot reach resources inside module.platform, so the document-extraction module's
# ocr.tftest.hcl asserts the endpoint, policy, egress rule, and environment this plan creates.
run "plans_document_ocr_in_a_region_that_offers_textract" {
  command = plan

  variables {
    document_extraction_ocr_enabled = true
  }

  override_data {
    target = module.platform.module.document_extraction.data.aws_vpc_endpoint_service.textract
    values = {
      service_name     = "com.amazonaws.us-east-2.textract"
      private_dns_name = "textract.us-east-2.amazonaws.com"
    }
  }
}
