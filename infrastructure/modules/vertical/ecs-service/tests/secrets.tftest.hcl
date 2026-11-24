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

variables {
  name                           = "test-service"
  cluster_arn                    = "arn:aws:ecs:us-east-2:123456789012:cluster/test"
  vpc_id                         = "vpc-12345678"
  subnet_ids                     = ["subnet-12345678"]
  service_discovery_namespace_id = "ns-12345678"
  image                          = "example.invalid/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  cpu                            = 256
  memory                         = 512
}

run "authorizes_service_and_init_container_parameters" {
  command = plan

  variables {
    secrets = {
      VALUE = "arn:aws:ssm:us-east-2:123456789012:parameter/test/value"
    }
    init_containers = [{
      name    = "migrate"
      image   = "example.invalid/migrate@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      command = ["migrate"]
      secrets = {
        VALUE    = "arn:aws:ssm:us-east-2:123456789012:parameter/test/value"
        PASSWORD = "arn:aws:ssm:us-east-2:123456789012:parameter/test/password"
      }
    }]
  }

  assert {
    condition = toset(output.execution_secret_arns) == toset([
      "arn:aws:ssm:us-east-2:123456789012:parameter/test/value",
      "arn:aws:ssm:us-east-2:123456789012:parameter/test/password",
    ])
    error_message = "The execution role must read exactly the referenced parameters, once each."
  }
}

run "rejects_secrets_manager_arns" {
  command = plan

  variables {
    secrets = {
      VALUE = "arn:aws:secretsmanager:us-east-2:123456789012:secret:value-AbCdEf"
    }
  }

  expect_failures = [var.secrets]
}

run "rejects_secrets_manager_arns_in_init_containers" {
  command = plan

  variables {
    init_containers = [{
      name    = "migrate"
      image   = "example.invalid/migrate@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      command = ["migrate"]
      secrets = {
        VALUE = "arn:aws:secretsmanager:us-east-2:123456789012:secret:value-AbCdEf"
      }
    }]
  }

  expect_failures = [var.init_containers]
}
