provider "aws" {
  access_key                  = "local"
  secret_key                  = "local"
  region                      = var.aws_region
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  skip_requesting_account_id  = true

  endpoints {
    apigatewayv2   = var.aws_endpoint_url
    dynamodb       = var.aws_endpoint_url
    events         = var.aws_endpoint_url
    lambda         = var.aws_endpoint_url
    s3             = var.aws_endpoint_url
    secretsmanager = var.aws_endpoint_url
    sqs            = var.aws_endpoint_url
    sts            = var.aws_endpoint_url
  }

  default_tags {
    tags = {
      Environment = "local"
      ManagedBy   = "terraform"
      Product     = "deployments-ai-platform"
    }
  }
}
