mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_data "aws_region" {
    defaults = {
      region = "us-east-2"
    }
  }

  mock_data "aws_vpc" {
    defaults = {
      cidr_block = "10.0.0.0/16"
    }
  }
}

mock_provider "random" {}

variables {
  alarm_topic_arn                 = "arn:aws:sns:us-east-2:123456789012:ops-alerts"
  compact_task_sizing_enabled     = true
  deletion_protection_enabled     = true
  domain_name                     = "web-tools.example.com"
  ecs_cluster_arn                 = "arn:aws:ecs:us-east-2:123456789012:cluster/platform"
  environment                     = "test"
  fargate_spot_enabled            = false
  firecrawl_embedding_model_name  = "openai/text-embedding-3-small"
  firecrawl_image                 = "123456789012.dkr.ecr.us-east-2.amazonaws.com/firecrawl@sha256:7777777777777777777777777777777777777777777777777777777777777777"
  firecrawl_model_name            = "openai/gpt-4o"
  load_balancer_arn               = "arn:aws:elasticloadbalancing:us-east-2:123456789012:loadbalancer/app/web-tools/0123456789abcdef"
  load_balancer_dns_name          = "internal-web-tools.us-east-2.elb.amazonaws.com"
  load_balancer_security_group_id = "sg-0123456789abcdef0"
  load_balancer_zone_id           = "Z3AADJGX6KTTL2"
  log_retention_in_days           = 30
  model_gateway_base_url          = "https://model-gateway.internal/v1"
  model_gateway_token_issuer = {
    arn           = "arn:aws:lambda:us-east-2:123456789012:function:web-tools-token-issuer"
    function_name = "web-tools-token-issuer"
  }
  point_in_time_recovery_enabled = true
  private_subnet_ids             = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
  proxy_image                    = "123456789012.dkr.ecr.us-east-2.amazonaws.com/web-tools-proxy@sha256:3333333333333333333333333333333333333333333333333333333333333333"
  reserved_ipv4_egress_filtered  = true
  route53_zone_id                = "Z0000000000000000000"
  vpc_id                         = "vpc-0123456789abcdef0"

  # The fork's apps/api/src/services/dynamo/dynamodb-table.json.
  firecrawl_table = {
    version      = 1
    billing_mode = "PAY_PER_REQUEST"
    hash_key     = "pk"
    range_key    = "sk"
    attributes = [
      { name = "pk", type = "S" },
      { name = "sk", type = "S" },
      { name = "gsi1pk", type = "S" },
      { name = "gsi1sk", type = "S" },
      { name = "gsi2pk", type = "S" },
      { name = "gsi2sk", type = "S" },
      { name = "gsi3pk", type = "S" },
      { name = "gsi3sk", type = "S" },
    ]
    ttl_attribute = "ttl"
    global_secondary_indexes = [
      {
        name               = "gsi1"
        hash_key           = "gsi1pk"
        range_key          = "gsi1sk"
        projection_type    = "INCLUDE"
        non_key_attributes = ["id", "lock", "lockedAt", "notBefore", "stalls", "readySortKey"]
      },
      {
        name               = "gsi2"
        hash_key           = "gsi2pk"
        range_key          = "gsi2sk"
        projection_type    = "INCLUDE"
        non_key_attributes = ["id", "status", "mode", "ownerId"]
      },
      {
        name            = "gsi3"
        hash_key        = "gsi3pk"
        range_key       = "gsi3sk"
        projection_type = "KEYS_ONLY"
      },
    ]
  }
}

run "renders_the_image_table_definition" {
  command = plan

  plan_options {
    target = [aws_dynamodb_table.firecrawl]
  }

  assert {
    condition = (
      aws_dynamodb_table.firecrawl.billing_mode == "PAY_PER_REQUEST" &&
      aws_dynamodb_table.firecrawl.hash_key == "pk" &&
      aws_dynamodb_table.firecrawl.range_key == "sk"
    )
    error_message = "The table billing mode and primary key must come from firecrawl_table."
  }

  assert {
    condition = toset([
      for attribute in aws_dynamodb_table.firecrawl.attribute : "${attribute.name}:${attribute.type}"
    ]) == toset(["pk:S", "sk:S", "gsi1pk:S", "gsi1sk:S", "gsi2pk:S", "gsi2sk:S", "gsi3pk:S", "gsi3sk:S"])
    error_message = "The table attributes must be exactly firecrawl_table.attributes."
  }

  assert {
    condition = {
      for gsi in aws_dynamodb_table.firecrawl.global_secondary_index : gsi.name => {
        keys       = [for key in gsi.key_schema : "${key.key_type}:${key.attribute_name}"]
        non_key    = gsi.non_key_attributes == null ? [] : sort(gsi.non_key_attributes)
        projection = gsi.projection_type
      }
      } == {
      gsi1 = {
        keys       = ["HASH:gsi1pk", "RANGE:gsi1sk"]
        non_key    = sort(["id", "lock", "lockedAt", "notBefore", "stalls", "readySortKey"])
        projection = "INCLUDE"
      }
      gsi2 = {
        keys       = ["HASH:gsi2pk", "RANGE:gsi2sk"]
        non_key    = sort(["id", "status", "mode", "ownerId"])
        projection = "INCLUDE"
      }
      gsi3 = {
        keys       = ["HASH:gsi3pk", "RANGE:gsi3sk"]
        non_key    = []
        projection = "KEYS_ONLY"
      }
    }
    error_message = "The global secondary indexes must be exactly firecrawl_table.global_secondary_indexes."
  }

  assert {
    condition = (
      aws_dynamodb_table.firecrawl.ttl[0].attribute_name == "ttl" &&
      aws_dynamodb_table.firecrawl.ttl[0].enabled
    )
    error_message = "TTL must be enabled on firecrawl_table.ttl_attribute."
  }

  assert {
    condition = (
      aws_dynamodb_table.firecrawl.name == "web-tools-firecrawl" &&
      aws_dynamodb_table.firecrawl.deletion_protection_enabled &&
      aws_dynamodb_table.firecrawl.point_in_time_recovery[0].enabled &&
      !aws_dynamodb_table.firecrawl.server_side_encryption[0].enabled &&
      aws_dynamodb_table.firecrawl.tags["Name"] == "web-tools-firecrawl"
    )
    error_message = "The table keeps its name, deletion protection, PITR, AWS owned key, and tags."
  }
}

run "follows_a_changed_definition" {
  command = plan

  plan_options {
    target = [aws_dynamodb_table.firecrawl]
  }

  variables {
    deletion_protection_enabled    = false
    point_in_time_recovery_enabled = false
    firecrawl_table = {
      version      = 1
      billing_mode = "PAY_PER_REQUEST"
      hash_key     = "id"
      attributes = [
        { name = "id", type = "S" },
        { name = "queue", type = "S" },
        { name = "ready", type = "N" },
      ]
      ttl_attribute = "expiresAt"
      global_secondary_indexes = [
        { name = "by-queue", hash_key = "queue", range_key = "ready", projection_type = "ALL" },
        { name = "by-ready", hash_key = "ready", projection_type = "KEYS_ONLY" },
      ]
    }
  }

  assert {
    condition = (
      aws_dynamodb_table.firecrawl.hash_key == "id" &&
      aws_dynamodb_table.firecrawl.range_key == null &&
      toset([
        for attribute in aws_dynamodb_table.firecrawl.attribute : "${attribute.name}:${attribute.type}"
      ]) == toset(["id:S", "queue:S", "ready:N"])
    )
    error_message = "A hash-only table and its attributes must follow firecrawl_table."
  }

  assert {
    condition = {
      for gsi in aws_dynamodb_table.firecrawl.global_secondary_index :
      gsi.name => [for key in gsi.key_schema : "${key.key_type}:${key.attribute_name}"]
      } == {
      by-queue = ["HASH:queue", "RANGE:ready"]
      by-ready = ["HASH:ready"]
    }
    error_message = "Index key schemas, including a hash-only index, must follow firecrawl_table."
  }

  assert {
    condition = (
      aws_dynamodb_table.firecrawl.ttl[0].attribute_name == "expiresAt" &&
      !aws_dynamodb_table.firecrawl.deletion_protection_enabled &&
      !aws_dynamodb_table.firecrawl.point_in_time_recovery[0].enabled
    )
    error_message = "The TTL attribute must follow firecrawl_table; protection settings follow their variables."
  }
}

run "rejects_another_definition_version" {
  command = plan

  plan_options {
    target = [aws_dynamodb_table.firecrawl]
  }

  variables {
    firecrawl_table = {
      version                  = 2
      billing_mode             = "PAY_PER_REQUEST"
      hash_key                 = "pk"
      attributes               = [{ name = "pk", type = "S" }]
      ttl_attribute            = "ttl"
      global_secondary_indexes = []
    }
  }

  expect_failures = [var.firecrawl_table]
}

run "rejects_an_undeclared_key_attribute" {
  command = plan

  plan_options {
    target = [aws_dynamodb_table.firecrawl]
  }

  variables {
    firecrawl_table = {
      version                  = 1
      billing_mode             = "PAY_PER_REQUEST"
      hash_key                 = "pk"
      range_key                = "sk"
      attributes               = [{ name = "pk", type = "S" }]
      ttl_attribute            = "ttl"
      global_secondary_indexes = []
    }
  }

  expect_failures = [var.firecrawl_table]
}

run "rejects_an_include_projection_without_attributes" {
  command = plan

  plan_options {
    target = [aws_dynamodb_table.firecrawl]
  }

  variables {
    firecrawl_table = {
      version       = 1
      billing_mode  = "PAY_PER_REQUEST"
      hash_key      = "pk"
      attributes    = [{ name = "pk", type = "S" }, { name = "queue", type = "S" }]
      ttl_attribute = "ttl"
      global_secondary_indexes = [
        { name = "by-queue", hash_key = "queue", projection_type = "INCLUDE" },
      ]
    }
  }

  expect_failures = [var.firecrawl_table]
}
