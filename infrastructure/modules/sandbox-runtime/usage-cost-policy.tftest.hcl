mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

variables {
  environment                     = "dev"
  lambda_microvm_enabled          = true
  lambda_microvm_image_identifier = "arn:aws:lambda:us-east-2:123456789012:microvm-image:deployments-ai-sandbox"
  lambda_microvm_image_version    = "1"
  log_retention_in_days           = 30
}

run "leaves_the_worker_environment_unchanged_without_a_policy" {
  command = apply

  assert {
    condition = output.lambda_microvm_runtime_configuration == {
      DEPLOYMENTS_AI_LAMBDA_MICROVM_EXECUTION_ROLE_ARN = aws_iam_role.microvm_execution[0].arn
      DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_IDENTIFIER   = "arn:aws:lambda:us-east-2:123456789012:microvm-image:deployments-ai-sandbox"
      DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_VERSION      = "1"
      DEPLOYMENTS_AI_LAMBDA_MICROVM_LOG_GROUP          = "/aws/lambda-microvms/deployments-ai-sandbox"
      DEPLOYMENTS_AI_SANDBOX_PROVIDER                  = "aws_lambda_microvm"
    }
    error_message = "An install without a sandbox cost policy must not add worker environment."
  }
}

run "uses_an_install_supplied_execution_role_instead_of_creating_one" {
  command = plan

  variables {
    lambda_microvm_execution_role_arn = "arn:aws:iam::123456789012:role/install-microvm"
  }

  assert {
    condition     = length(aws_iam_role.microvm_execution) == 0
    error_message = "An install that passes its own execution role must not get a second one."
  }

  assert {
    condition     = output.lambda_microvm_runtime_configuration["DEPLOYMENTS_AI_LAMBDA_MICROVM_EXECUTION_ROLE_ARN"] == "arn:aws:iam::123456789012:role/install-microvm"
    error_message = "The worker must pass the install's execution role to each MicroVM."
  }
}

run "passes_the_image_capacity_to_the_worker" {
  command = plan

  variables {
    lambda_microvm_image_capacity = { memory_mib = 4096, vcpu = 2 }
  }

  assert {
    condition = (
      output.lambda_microvm_runtime_configuration["DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_MEMORY_MIB"] == "4096" &&
      output.lambda_microvm_runtime_configuration["DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_VCPU"] == "2"
    )
    error_message = "The worker must reserve and meter the capacity of the image it runs."
  }
}

run "rejects_an_unsupported_image_capacity" {
  command = plan

  variables {
    lambda_microvm_image_capacity = { memory_mib = 4096, vcpu = 1 }
  }

  expect_failures = [var.lambda_microvm_image_capacity]
}

run "passes_the_set_rates_to_the_worker" {
  command = plan

  variables {
    usage_cost_policy = {
      memory_gib_hour_usd_micros = 13200
      vcpu_hour_usd_micros       = 99700
    }
  }

  assert {
    condition     = output.lambda_microvm_runtime_configuration["DEPLOYMENTS_AI_SANDBOX_USAGE_COST_POLICY"] == "{\"memoryGiBHourUsdMicros\":13200,\"vcpuHourUsdMicros\":99700}"
    error_message = "The worker must receive only the rates the install set, under their runtime names."
  }
}
