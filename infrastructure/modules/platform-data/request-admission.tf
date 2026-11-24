resource "aws_dynamodb_table" "request_admission" {
  name         = "request-admission"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  deletion_protection_enabled = var.deletion_protection_enabled

  attribute {
    name = "pk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = false
  }

  # enabled = false selects the AWS owned key; omitting the block would keep a prior key.
  server_side_encryption {
    enabled = false
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = merge(local.common_tags, {
    Name = "request-admission"
  })
}
