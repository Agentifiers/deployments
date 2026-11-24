# The real AWS provider plans offline with fake credentials, so the gateway policy document renders
# at plan time.
provider "aws" {
  region                      = "us-east-2"
  access_key                  = "test"
  secret_key                  = "test"
  max_retries                 = 1
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  skip_requesting_account_id  = true
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_resource {
  target = aws_kms_key.token_signing
  values = { arn = "arn:aws:kms:us-east-2:123456789012:key/00000000-0000-4000-8000-000000000001" }
}

variables {
  alarm_topic_arn             = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
  bifrost_image               = "123456789012.dkr.ecr.us-east-2.amazonaws.com/bifrost@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  compact_task_sizing_enabled = true
  container_insights_enabled  = false
  control_table_arn           = "arn:aws:dynamodb:us-east-2:123456789012:table/control"
  control_table_name          = "control"
  deletion_protection_enabled = false
  environment                 = "dev"
  execution_table_arn         = "arn:aws:dynamodb:us-east-2:123456789012:table/execution"
  execution_table_name        = "execution"
  kms_deletion_window_in_days = 7
  log_retention_in_days       = 30
  model_gateway_image         = "123456789012.dkr.ecr.us-east-2.amazonaws.com/model-gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
  private_subnet_ids          = ["subnet-00000000000000001"]
  usage_table_arn             = "arn:aws:dynamodb:us-east-2:123456789012:table/usage"
  usage_table_name            = "usage"
  vpc_cidr                    = "10.0.0.0/16"
  vpc_id                      = "vpc-00000000000000001"
}

run "gateway_reads_only_organization_standing_and_month_spend" {
  command = plan

  assert {
    condition = [
      for statement in jsondecode(data.aws_iam_policy_document.gateway.json).Statement :
      statement if contains(["ReadOrganizationControlRecords", "ReadOrganizationMonthSpend"], statement.Sid)
      ] == [
      {
        Sid      = "ReadOrganizationControlRecords"
        Effect   = "Allow"
        Action   = "dynamodb:GetItem"
        Resource = "arn:aws:dynamodb:us-east-2:123456789012:table/control"
        Condition = {
          "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = "ORG#*" }
        }
      },
      {
        Sid      = "ReadOrganizationMonthSpend"
        Effect   = "Allow"
        Action   = "dynamodb:Query"
        Resource = "arn:aws:dynamodb:us-east-2:123456789012:table/usage"
        Condition = {
          "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = "ORG#*#SPEND#ORGANIZATION" }
        }
      },
    ]
    error_message = "The gateway may only get items in organization partitions of the control table and query organization spend partitions of the usage table."
  }

  assert {
    condition = {
      for variable in local.gateway_container.environment :
      variable.name => variable.value
      if contains(["DEPLOYMENTS_AI_CONTROL_TABLE", "DEPLOYMENTS_AI_USAGE_TABLE"], variable.name)
      } == {
      DEPLOYMENTS_AI_CONTROL_TABLE = "control"
      DEPLOYMENTS_AI_USAGE_TABLE   = "usage"
    }
    error_message = "The gateway must receive the control and usage tables it reads the spend ceiling and month spend from."
  }

  assert {
    condition = length([
      for variable in local.gateway_container.environment :
      variable if variable.name == "DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS"
    ]) == 0
    error_message = "Without a default ceiling the gateway must leave organizations without a grant unlimited."
  }
}

run "gateway_applies_the_default_spend_ceiling" {
  command = plan

  variables {
    default_model_spend_ceiling_usd_micros = 5000000
  }

  assert {
    condition = [
      for variable in local.gateway_container.environment :
      variable.value if variable.name == "DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS"
    ] == ["5000000"]
    error_message = "The gateway must receive the same default operator-funded spend ceiling as the token issuers."
  }
}

run "gateway_opens_no_organization_keys_without_model_credentials" {
  command = plan

  assert {
    condition = length([
      for statement in jsondecode(data.aws_iam_policy_document.gateway.json).Statement :
      statement if statement.Sid == "OpenOrganizationModelCredentials"
    ]) == 0
    error_message = "Without model credentials the gateway must not decrypt organization keys."
  }

  assert {
    condition = length([
      for variable in local.gateway_container.environment :
      variable if variable.name == "DEPLOYMENTS_AI_MODEL_CREDENTIAL_KMS_KEY_ARN"
    ]) == 0
    error_message = "Without model credentials the gateway must not be given the credential key."
  }
}

run "gateway_opens_only_model_provider_credentials" {
  command = plan

  variables {
    model_credentials = {
      kms_key_arn = "arn:aws:kms:us-east-2:123456789012:key/22222222-3333-4444-5555-666666666666"
    }
  }

  assert {
    condition = [
      for statement in jsondecode(data.aws_iam_policy_document.gateway.json).Statement :
      statement if statement.Sid == "OpenOrganizationModelCredentials"
      ] == [
      {
        Sid      = "OpenOrganizationModelCredentials"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = "arn:aws:kms:us-east-2:123456789012:key/22222222-3333-4444-5555-666666666666"
        Condition = {
          StringEquals = { "kms:EncryptionContext:purpose" = "model-provider-credential" }
        }
      },
    ]
    error_message = "The gateway may decrypt only model provider credentials, only with the dedicated key."
  }

  assert {
    condition = {
      for variable in local.gateway_container.environment :
      variable.name => variable.value
      if contains(["DEPLOYMENTS_AI_MODEL_CREDENTIAL_KMS_KEY_ARN", "DEPLOYMENTS_AI_STAGE"], variable.name)
      } == {
      DEPLOYMENTS_AI_MODEL_CREDENTIAL_KMS_KEY_ARN = "arn:aws:kms:us-east-2:123456789012:key/22222222-3333-4444-5555-666666666666"
      DEPLOYMENTS_AI_STAGE                        = "dev"
    }
    error_message = "The gateway must receive the credential key and the stage that binds sealed keys."
  }
}
