output "lambda_microvm_artifact_bucket_name" {
  value = try(aws_s3_bucket.microvm_artifacts[0].id, null)
}

output "lambda_microvm_build_role_arn" {
  value = try(aws_iam_role.microvm_build[0].arn, null)
}

output "lambda_microvm_log_group_name" {
  value = try(aws_cloudwatch_log_group.microvm[0].name, null)
}

output "lambda_microvm_runtime_policy_arn" {
  value = try(aws_iam_policy.lambda_microvm_runtime[0].arn, null)
}

output "lambda_microvm_execution_role_arn" {
  value = var.lambda_microvm_enabled ? local.lambda_microvm_execution_role_arn : null
}

output "lambda_microvm_runtime_configuration" {
  value = var.lambda_microvm_enabled ? merge(
    {
      DEPLOYMENTS_AI_LAMBDA_MICROVM_EXECUTION_ROLE_ARN = local.lambda_microvm_execution_role_arn
      DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_IDENTIFIER   = trimspace(var.lambda_microvm_image_identifier)
      DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_VERSION      = trimspace(var.lambda_microvm_image_version)
      # Without a run-level log group, Lambda writes each image's runtime logs to a new log group
      # with no retention.
      DEPLOYMENTS_AI_LAMBDA_MICROVM_LOG_GROUP = aws_cloudwatch_log_group.microvm[0].name
      DEPLOYMENTS_AI_SANDBOX_PROVIDER         = "aws_lambda_microvm"
    },
    var.lambda_microvm_image_capacity == null ? {} : {
      DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_MEMORY_MIB = tostring(var.lambda_microvm_image_capacity.memory_mib)
      DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_VCPU       = tostring(var.lambda_microvm_image_capacity.vcpu)
    },
    var.usage_cost_policy == null ? {} : {
      DEPLOYMENTS_AI_SANDBOX_USAGE_COST_POLICY = jsonencode({
        for name, rate in {
          baseHourUsdMicros      = var.usage_cost_policy.base_hour_usd_micros
          memoryGiBHourUsdMicros = var.usage_cost_policy.memory_gib_hour_usd_micros
          vcpuHourUsdMicros      = var.usage_cost_policy.vcpu_hour_usd_micros
        } : name => rate if rate != null
      })
    },
  ) : null
}
