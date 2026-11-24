mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111122223333"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::111122223333:role/platform-release-publisher"
    }
  }

  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::111122223333:policy/platform-release-reader"
    }
  }
}

variables {
  github_subject = "repo:acme@1/example@2:ref:refs/heads/main"
}

run "default_configuration" {
  command = apply

  variables {
    bucket_name = "platform-releases-test"
  }

  assert {
    condition = [
      for rule in aws_s3_bucket_lifecycle_configuration.releases.rule : {
        id   = rule.id
        days = rule.expiration[0].days
        tags = rule.filter[0].and[0].tags
      } if length(rule.expiration) > 0 && try(rule.expiration[0].days > 0, false)
    ] == [{ id = "expire-dev-payloads", days = 180, tags = tomap({ object = "payload", retention = "dev" }) }]
    error_message = "Exactly one lifecycle rule may expire current objects, and only those tagged both retention=dev and object=payload, after 180 days."
  }

  assert {
    condition     = !strcontains(jsonencode(aws_s3_bucket_lifecycle_configuration.releases.rule[*].filter), "customer")
    error_message = "No lifecycle rule may select retention=customer objects."
  }

  assert {
    condition = contains(jsondecode(aws_s3_bucket_policy.releases.policy).Statement, {
      Sid       = "DenyObjectDeletion"
      Effect    = "Deny"
      Principal = "*"
      Action    = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
      Resource  = "arn:aws:s3:::platform-releases-test/*"
    })
    error_message = "The bucket policy must deny object and version deletion to every principal without conditions."
  }

  assert {
    condition = contains(jsondecode(aws_s3_bucket_policy.releases.policy).Statement, {
      Sid       = "DenyObjectWritesExceptPublisher"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:PutObject"
      Resource  = "arn:aws:s3:::platform-releases-test/*"
      Condition = {
        ArnNotEquals = { "aws:PrincipalArn" = "arn:aws:iam::111122223333:role/platform-release-publisher" }
      }
    })
    error_message = "The bucket policy must deny object writes to every principal except the publisher role."
  }

  assert {
    condition = contains(jsondecode(aws_s3_bucket_policy.releases.policy).Statement, {
      Sid       = "DenyRetainedObjectRetagging"
      Effect    = "Deny"
      Principal = "*"
      Action    = ["s3:PutObjectTagging", "s3:PutObjectVersionTagging"]
      Resource  = "arn:aws:s3:::platform-releases-test/*"
      Condition = {
        StringEquals = { "s3:ExistingObjectTag/retention" = "customer" }
      }
    })
    error_message = "No principal may retag an object tagged retention=customer, or the lifecycle could expire it."
  }

  assert {
    condition = contains(jsondecode(aws_s3_bucket_policy.releases.policy).Statement, {
      Sid       = "DenyRetentionOtherThanCustomerExceptPublisher"
      Effect    = "Deny"
      Principal = "*"
      Action    = ["s3:PutObjectTagging", "s3:PutObjectVersionTagging"]
      Resource  = "arn:aws:s3:::platform-releases-test/*"
      Condition = {
        ArnNotEquals    = { "aws:PrincipalArn" = "arn:aws:iam::111122223333:role/platform-release-publisher" }
        StringNotEquals = { "s3:RequestObjectTag/retention" = "customer" }
      }
    })
    error_message = "Principals other than the publisher may set only retention=customer."
  }

  assert {
    condition = contains(jsondecode(aws_s3_bucket_policy.releases.policy).Statement, {
      Sid       = "RecordsOutlivePayloadExpiry"
      Effect    = "Deny"
      Principal = "*"
      Action    = ["s3:PutObject", "s3:PutObjectTagging", "s3:PutObjectVersionTagging"]
      Resource = [
        "arn:aws:s3:::platform-releases-test/releases/*/release-record.json",
        "arn:aws:s3:::platform-releases-test/releases/*/release-record.sig.json",
      ]
      Condition = {
        Null = { "s3:RequestObjectTag/object" = "false" }
      }
    })
    error_message = "No principal may tag a release record or signature object=payload, or the lifecycle could expire it."
  }

  assert {
    condition = [
      for statement in jsondecode(aws_kms_key.signing.policy).Statement : statement.Principal.AWS
      if statement.Effect == "Allow" && contains(flatten([statement.Action]), "kms:Sign")
    ] == ["arn:aws:iam::111122223333:role/platform-release-publisher"]
    error_message = "Only the publisher role may sign with the release signing key."
  }

  assert {
    condition = alltrue(flatten([
      for statement in jsondecode(aws_kms_key.signing.policy).Statement : [
        for action in flatten([statement.Action]) : !strcontains(action, "*") && action != "kms:CreateGrant"
      ]
    ]))
    error_message = "The key policy must name each action and must not allow kms:CreateGrant, which could delegate signing."
  }

  assert {
    condition = anytrue([
      for statement in jsondecode(aws_kms_key.signing.policy).Statement :
      statement.Effect == "Allow" && statement.Principal.AWS == "arn:aws:iam::111122223333:root" && contains(flatten([statement.Action]), "kms:PutKeyPolicy")
    ])
    error_message = "The account root must keep key administration, or no one can change the key policy."
  }

  assert {
    condition = contains(jsondecode(aws_kms_key.signing.policy).Statement, {
      Sid       = "ReadPublicKey"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::111122223333:root" }
      Action    = "kms:GetPublicKey"
      Resource  = "*"
    })
    error_message = "IAM policies in the registry account must be able to let verifiers read the public key."
  }

  assert {
    condition     = jsondecode(aws_iam_role.publisher.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:acme@1/example@2:ref:refs/heads/main"
    error_message = "The publisher role must trust exactly the configured ref subject."
  }

  assert {
    condition     = length(aws_iam_role_policy_attachment.reader) == 0
    error_message = "An empty reader_role_names must attach the reader policy to no role."
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 1
    error_message = "A null github_oidc_provider_arn must create the GitHub OIDC provider."
  }
}

run "existing_oidc_provider" {
  command = plan

  variables {
    bucket_name              = "platform-releases-test"
    github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0
    error_message = "A supplied github_oidc_provider_arn must not create another OIDC provider."
  }

  assert {
    condition     = jsondecode(aws_iam_role.publisher.assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    error_message = "The publisher role must trust the supplied OIDC provider."
  }
}

run "environment_subject_and_reader_roles" {
  command = apply

  variables {
    bucket_name       = "platform-releases-test"
    github_subject    = "repo:acme@1/example@2:environment:production"
    reader_role_names = ["release-reader", "release-operator"]
  }

  assert {
    condition     = jsondecode(aws_iam_role.publisher.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:acme@1/example@2:environment:production"
    error_message = "The publisher role must trust exactly the configured environment subject."
  }

  assert {
    condition = {
      for name, attachment in aws_iam_role_policy_attachment.reader : name => {
        role       = attachment.role
        policy_arn = attachment.policy_arn
      }
      } == {
      release-reader   = { role = "release-reader", policy_arn = "arn:aws:iam::111122223333:policy/platform-release-reader" }
      release-operator = { role = "release-operator", policy_arn = "arn:aws:iam::111122223333:policy/platform-release-reader" }
    }
    error_message = "Each of reader_role_names must get the reader policy, and no other role may."
  }
}

run "subject_without_environment_or_ref" {
  command = plan

  variables {
    bucket_name    = "platform-releases-test"
    github_subject = "repo:acme@1/example@2:pull_request"
  }

  expect_failures = [var.github_subject]
}

run "subject_without_repository" {
  command = plan

  variables {
    bucket_name    = "platform-releases-test"
    github_subject = "acme@1/example@2:ref:refs/heads/main"
  }

  expect_failures = [var.github_subject]
}
