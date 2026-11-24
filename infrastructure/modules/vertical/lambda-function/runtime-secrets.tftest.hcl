# OpenTofu mocks give computed attributes generated values at plan, so every ARN the
# provider validates at plan comes from a mock default here.
mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

run "compacts_parameter_names_under_one_path" {
  command = plan

  variables {
    name     = "parameter-secrets-test"
    filename = "main.tf"
    secret_environment = {
      EXAMPLE_SECRET = "arn:aws:ssm:us-east-2:123456789012:parameter/verticals/dev/example/secrets/example"
      OTHER_SECRET   = "arn:aws:ssm:us-east-2:123456789012:parameter/verticals/dev/example/secrets/other"
    }
  }

  assert {
    condition = aws_lambda_function.this.environment[0].variables[
      "DEPLOYMENTS_AI_TERRAFORM_RUNTIME_SECRET_PREFIX"
    ] == "/verticals/dev/example/secrets/"
    error_message = "The prefix must be the shared parameter path with one trailing separator."
  }

  assert {
    condition = jsondecode(aws_lambda_function.this.environment[0].variables[
      "DEPLOYMENTS_AI_TERRAFORM_RUNTIME_SECRET_ARNS"
    ]) == { EXAMPLE_SECRET = "example", OTHER_SECRET = "other" }
    error_message = "Each secret must be reduced to its name below the shared path."
  }
}

run "rejects_secrets_manager_arns" {
  command = plan

  variables {
    name     = "secrets-manager-test"
    filename = "main.tf"
    secret_environment = {
      EXAMPLE_SECRET = "arn:aws:secretsmanager:us-east-2:123456789012:secret:example-dev/runtime/example-ABC123"
    }
  }

  expect_failures = [var.secret_environment]
}

run "rejects_mixed_parameter_paths" {
  command = plan

  variables {
    name     = "mixed-path-test"
    filename = "main.tf"
    secret_environment = {
      EXAMPLE_SECRET = "arn:aws:ssm:us-east-2:123456789012:parameter/example/one/example"
      OTHER_SECRET   = "arn:aws:ssm:us-east-2:123456789012:parameter/example/two/other"
    }
  }

  expect_failures = [aws_lambda_function.this]
}

run "rejects_root_parameters" {
  command = plan

  variables {
    name     = "root-parameter-test"
    filename = "main.tf"
    secret_environment = {
      EXAMPLE_SECRET = "arn:aws:ssm:us-east-2:123456789012:parameter/example"
    }
  }

  expect_failures = [aws_lambda_function.this]
}
