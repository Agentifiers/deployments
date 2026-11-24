terraform {
  required_version = ">= 1.13.0"

  # Local state: this root creates the state bucket every later root uses.
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.55.0, < 7.0"
    }
  }
}
