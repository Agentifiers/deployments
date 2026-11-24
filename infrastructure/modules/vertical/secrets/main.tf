data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_region" "current" {}

# Runtime secrets are SecureString parameters that an operator or tool writes out of band.
# OpenTofu only names them: a managed parameter would need a placeholder value, and a reader
# cannot tell a placeholder from a real secret, while a parameter that does not exist yet reads
# as missing. No value ever reaches state.
locals {
  parameter_names = { for name in var.secret_names : name => "${var.path}/${name}" }
}

# Secrets Manager secrets from earlier releases of this module stay in the account until the
# operator deletes them after copying their values to the parameters.
removed {
  from = aws_secretsmanager_secret.this

  lifecycle {
    destroy = false
  }
}
