mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/mock" }
  }
}

variables {
  aws_account_id         = "123456789012"
  aws_region             = "us-east-2"
  environment_name       = "acme"
  external_id            = "acme-7f3c2a9e41b8d605"
  deploy_principal_arn   = "arn:aws:iam::210987654321:role/partner-deployer"
  observer_principal_arn = "arn:aws:iam::210987654321:role/partner-observer"
}

run "trusts_cross_account_principals_only_with_the_external_id" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement == [{
      Sid       = "DeployPrincipal"
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = "arn:aws:iam::210987654321:role/partner-deployer" }
      Condition = { StringEquals = { "sts:ExternalId" = "acme-7f3c2a9e41b8d605" } }
    }]
    error_message = "The deploy role must trust only the deploy principal presenting the external ID."
  }

  assert {
    condition = jsondecode(aws_iam_role.observer[0].assume_role_policy).Statement == [{
      Sid       = "ObserverPrincipal"
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = "arn:aws:iam::210987654321:role/partner-observer" }
      Condition = { StringEquals = { "sts:ExternalId" = "acme-7f3c2a9e41b8d605" } }
    }]
    error_message = "The observer role must trust only the observer principal presenting the external ID."
  }

  assert {
    condition     = aws_iam_role.deploy.name == "platform-deploy" && aws_iam_role.deploy.max_session_duration == 43200 && aws_iam_role_policy_attachment.deploy["PowerUserAccess"].policy_arn == "arn:aws:iam::aws:policy/PowerUserAccess"
    error_message = "The deploy role must be platform-deploy with 12-hour sessions and PowerUserAccess."
  }
}

run "trusts_a_same_account_principal_without_an_external_id_and_skips_the_observer" {
  command = plan

  variables {
    external_id            = null
    deploy_principal_arn   = "arn:aws:iam::123456789012:role/ci-deployer"
    observer_principal_arn = null
  }

  assert {
    condition = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement == [{
      Sid       = "DeployPrincipal"
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = "arn:aws:iam::123456789012:role/ci-deployer" }
    }]
    error_message = "Without an external ID, the deploy role must trust the same-account principal with no ExternalId condition."
  }

  assert {
    condition     = length(aws_iam_role.observer) == 0 && length(aws_iam_role_policy.observer) == 0 && output.observer_role_arn == null
    error_message = "A null observer_principal_arn must create no observer role and output a null observer_role_arn."
  }
}

run "keeps_the_external_id_for_a_same_account_principal_when_set" {
  command = plan

  variables {
    deploy_principal_arn   = "arn:aws:iam::123456789012:user/ops/deployer"
    observer_principal_arn = null
  }

  assert {
    condition = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement == [{
      Sid       = "DeployPrincipal"
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = "arn:aws:iam::123456789012:user/ops/deployer" }
      Condition = { StringEquals = { "sts:ExternalId" = "acme-7f3c2a9e41b8d605" } }
    }]
    error_message = "A set external ID must be required of every principal, including a same-account IAM user."
  }
}

run "requires_an_external_id_for_a_cross_account_deploy_principal" {
  command = plan

  variables {
    external_id            = null
    observer_principal_arn = null
  }

  expect_failures = [var.external_id]
}

run "requires_an_external_id_for_a_cross_account_observer_principal" {
  command = plan

  variables {
    external_id          = null
    deploy_principal_arn = "arn:aws:iam::123456789012:role/ci-deployer"
  }

  expect_failures = [var.external_id]
}

run "rejects_a_short_external_id" {
  command = plan

  variables {
    external_id = "too-short"
  }

  expect_failures = [var.external_id]
}

run "rejects_an_account_root_deploy_principal" {
  command = plan

  variables {
    deploy_principal_arn = "arn:aws:iam::210987654321:root"
  }

  expect_failures = [var.deploy_principal_arn]
}

run "rejects_an_assumed_role_session_observer_principal" {
  command = plan

  variables {
    observer_principal_arn = "arn:aws:sts::210987654321:assumed-role/partner-observer/session"
  }

  expect_failures = [var.observer_principal_arn]
}

run "names_only_platform_roles_with_hyphenated_prefixes" {
  command = plan

  assert {
    condition = local.workload_role_arns == [
      "arn:aws:iam::123456789012:role/agent-*",
      "arn:aws:iam::123456789012:role/api-*",
      "arn:aws:iam::123456789012:role/apps-*",
      "arn:aws:iam::123456789012:role/brain-*",
      "arn:aws:iam::123456789012:role/channel-*",
      "arn:aws:iam::123456789012:role/console-*",
      "arn:aws:iam::123456789012:role/credential-*",
      "arn:aws:iam::123456789012:role/deployments-ai-platform-acme-*",
      "arn:aws:iam::123456789012:role/durable-*",
      "arn:aws:iam::123456789012:role/e2e-*",
      "arn:aws:iam::123456789012:role/email-*",
      "arn:aws:iam::123456789012:role/event-*",
      "arn:aws:iam::123456789012:role/events-*",
      "arn:aws:iam::123456789012:role/governance-*",
      "arn:aws:iam::123456789012:role/identity-*",
      "arn:aws:iam::123456789012:role/memory-*",
      "arn:aws:iam::123456789012:role/microvm-*",
      "arn:aws:iam::123456789012:role/models-*",
      "arn:aws:iam::123456789012:role/oauth-*",
      "arn:aws:iam::123456789012:role/ops-alerts-*",
      "arn:aws:iam::123456789012:role/platform-acme-*",
      "arn:aws:iam::123456789012:role/provider-*",
      "arn:aws:iam::123456789012:role/sandbox-*",
      "arn:aws:iam::123456789012:role/semantic-*",
      "arn:aws:iam::123456789012:role/web-tools-*",
      "arn:aws:iam::123456789012:role/api",
      "arn:aws:iam::123456789012:role/console",
    ]
    error_message = "The deploy role may manage only the platform's role names for this environment, and every prefix must end in a hyphen."
  }
}

run "caps_every_platform_role_with_the_workload_boundary" {
  command = plan

  assert {
    condition = aws_iam_policy.workload_boundary.name == "platform-workload-boundary" && jsondecode(aws_iam_policy.workload_boundary.policy).Statement == [
      {
        Sid       = "AllowWorkloadServices"
        Effect    = "Allow"
        NotAction = ["account:*", "iam:*", "organizations:*"]
        Resource  = "*"
      },
      {
        Sid      = "PassPlatformRoles"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = local.workload_role_arns
        Condition = { StringEquals = { "iam:PassedToService" = [
          "ec2.amazonaws.com",
          "ecs-tasks.amazonaws.com",
          "events.amazonaws.com",
          "firehose.amazonaws.com",
          "lambda.amazonaws.com",
          "scheduler.amazonaws.com",
        ] } }
      },
      {
        Sid       = "CreateSesServiceLinkedRole"
        Effect    = "Allow"
        Action    = "iam:CreateServiceLinkedRole"
        Resource  = "arn:aws:iam::123456789012:role/aws-service-role/ses.amazonaws.com/*"
        Condition = { StringEquals = { "iam:AWSServiceName" = "ses.amazonaws.com" } }
      },
      {
        Sid         = "DenyAssumingOtherRolesInThisAccount"
        Effect      = "Deny"
        Action      = "sts:AssumeRole"
        NotResource = local.workload_role_arns
        Condition   = { StringEquals = { "aws:ResourceAccount" = "123456789012" } }
      },
      {
        Sid    = "ProtectBootstrap"
        Effect = "Deny"
        Action = ["iam:*", "sts:AssumeRole"]
        Resource = [
          "arn:aws:iam::123456789012:role/platform-deploy",
          "arn:aws:iam::123456789012:role/platform-observer",
          "arn:aws:iam::123456789012:policy/platform-workload-boundary",
        ]
      },
    ]
    error_message = "The boundary must allow no IAM beyond passing platform roles to the deploy role's services and creating the SES service-linked role, no account or organizations actions, no assuming other roles in the account, and nothing on the bootstrap roles or itself."
  }
}

run "lets_the_deploy_role_write_only_roles_that_carry_the_boundary" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_role_policy.workload_iam.policy).Statement == [
      {
        Sid      = "ReadIamMetadata"
        Effect   = "Allow"
        Action   = ["iam:Get*", "iam:List*"]
        Resource = "*"
      },
      {
        Sid      = "ManageOpenSearchServiceLinkedRole"
        Effect   = "Allow"
        Action   = ["iam:CreateServiceLinkedRole", "iam:DeleteServiceLinkedRole", "iam:TagRole", "iam:UntagRole"]
        Resource = "arn:aws:iam::123456789012:role/aws-service-role/opensearchservice.amazonaws.com/AWSServiceRoleForAmazonOpenSearchService"
      },
      {
        Sid    = "ManagePlatformRolesWithinBoundary"
        Effect = "Allow"
        Action = [
          "iam:AttachRolePolicy",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:DeleteRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PutRolePermissionsBoundary",
          "iam:PutRolePolicy",
          "iam:UpdateAssumeRolePolicy",
          "iam:UpdateRole",
          "iam:UpdateRoleDescription",
        ]
        Resource  = local.workload_role_arns
        Condition = { StringEquals = { "iam:PermissionsBoundary" = "arn:aws:iam::123456789012:policy/platform-workload-boundary" } }
      },
      {
        Sid    = "ManagePlatformPolicies"
        Effect = "Allow"
        Action = [
          "iam:CreatePolicy",
          "iam:CreatePolicyVersion",
          "iam:DeletePolicy",
          "iam:DeletePolicyVersion",
          "iam:SetDefaultPolicyVersion",
          "iam:TagPolicy",
          "iam:UntagPolicy",
        ]
        Resource = local.workload_policy_arns
      },
      {
        Sid      = "TagPlatformRoles"
        Effect   = "Allow"
        Action   = ["iam:TagRole", "iam:UntagRole"]
        Resource = local.workload_role_arns
      },
      {
        Sid    = "ManagePlatformInstanceProfiles"
        Effect = "Allow"
        Action = [
          "iam:AddRoleToInstanceProfile",
          "iam:CreateInstanceProfile",
          "iam:DeleteInstanceProfile",
          "iam:RemoveRoleFromInstanceProfile",
          "iam:TagInstanceProfile",
          "iam:UntagInstanceProfile",
        ]
        Resource = local.workload_instance_profile_arns
      },
      {
        Sid      = "PassPlatformWorkloadRoles"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = local.workload_role_arns
        Condition = { StringEquals = { "iam:PassedToService" = [
          "ec2.amazonaws.com",
          "ecs-tasks.amazonaws.com",
          "events.amazonaws.com",
          "firehose.amazonaws.com",
          "lambda.amazonaws.com",
          "scheduler.amazonaws.com",
        ] } }
      },
      {
        Sid    = "RequireWorkloadBoundary"
        Effect = "Deny"
        Action = [
          "iam:AttachRolePolicy",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:DeleteRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PutRolePermissionsBoundary",
          "iam:PutRolePolicy",
          "iam:UpdateAssumeRolePolicy",
          "iam:UpdateRole",
          "iam:UpdateRoleDescription",
        ]
        Resource  = "*"
        Condition = { StringNotEquals = { "iam:PermissionsBoundary" = "arn:aws:iam::123456789012:policy/platform-workload-boundary" } }
      },
      {
        Sid      = "KeepWorkloadBoundary"
        Effect   = "Deny"
        Action   = "iam:DeleteRolePermissionsBoundary"
        Resource = "*"
      },
      {
        Sid    = "ProtectWorkloadBoundary"
        Effect = "Deny"
        Action = [
          "iam:CreatePolicy",
          "iam:CreatePolicyVersion",
          "iam:DeletePolicy",
          "iam:DeletePolicyVersion",
          "iam:SetDefaultPolicyVersion",
          "iam:TagPolicy",
          "iam:UntagPolicy",
        ]
        Resource = "arn:aws:iam::123456789012:policy/platform-workload-boundary"
      },
      {
        Sid    = "ProtectBootstrapRoles"
        Effect = "Deny"
        Action = [
          "iam:AttachRolePolicy",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:DeleteRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PutRolePermissionsBoundary",
          "iam:PutRolePolicy",
          "iam:UpdateAssumeRolePolicy",
          "iam:UpdateRole",
          "iam:UpdateRoleDescription",
          "iam:PassRole",
          "iam:TagRole",
          "iam:UntagRole",
        ]
        Resource = ["arn:aws:iam::123456789012:role/platform-deploy", "arn:aws:iam::123456789012:role/platform-observer"]
      },
    ]
    error_message = "The deploy role may write only platform roles that carry the workload boundary, may pass them only to its listed services, and may never remove a boundary, set another one, or change the boundary policy."
  }
}

run "fits_iam_policy_size_limits_with_the_longest_environment_name_and_partition" {
  command = plan

  variables {
    environment_name = "abcdefghijklmnop"
  }

  override_data {
    target = data.aws_partition.current
    values = { partition = "aws-us-gov" }
  }

  assert {
    condition     = length(aws_iam_role_policy.workload_iam.policy) <= 10240 && length(aws_iam_policy.workload_boundary.policy) <= 6144
    error_message = "The deploy role's inline policy must fit IAM's 10,240-character limit and the boundary its 6,144-character limit."
  }
}

run "lets_the_observer_invoke_only_observer_reads" {
  command = plan

  assert {
    condition = aws_iam_role.observer[0].name == "platform-observer" && jsondecode(aws_iam_role_policy.observer[0].policy).Statement == [{
      Sid      = "InvokeObserverRoutes"
      Effect   = "Allow"
      Action   = "execute-api:Invoke"
      Resource = "arn:aws:execute-api:us-east-2:123456789012:*/*/GET/v1/system/observer/*"
    }]
    error_message = "The observer role may only invoke GET /v1/system/observer/* in this account and region."
  }
}

run "denies_the_deploy_role_the_sign_in_client_secrets" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_policy.deny_client_secret_reads.policy).Statement == [{
      Sid      = "DenyClientSecretReads"
      Effect   = "Deny"
      Action   = "ssm:GetParameter*"
      Resource = ["arn:aws:ssm:us-east-2:123456789012:parameter/", "arn:aws:ssm:us-east-2:123456789012:parameter/identity", "arn:aws:ssm:us-east-2:123456789012:parameter/identity/web-oauth-client", "arn:aws:ssm:us-east-2:123456789012:parameter/identity/apps-*-oauth-client"]
    }] && aws_iam_role_policy_attachment.deny_client_secret_reads.role == "platform-deploy"
    error_message = "The deploy role must not read the web or apps OAuth client secret parameters, by name or by the /identity path."
  }
}
