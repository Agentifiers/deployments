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
  target = data.aws_vpc_endpoint_service.textract
  values = {
    service_name     = "com.amazonaws.us-east-2.textract"
    private_dns_name = "textract.us-east-2.amazonaws.com"
  }
}

variables {
  artifact_bucket       = "artifacts-123456789012"
  artifact_key          = "releases/sha256/a5/document-extraction.zip"
  artifact_version      = "v1"
  environment           = "acme"
  log_retention_in_days = 30
  network = {
    private_subnet_ids = ["subnet-00000000000000001", "subnet-00000000000000002"]
    s3_prefix_list_id  = "pl-00000000000000001"
    vpc_id             = "vpc-00000000000000001"
  }
}

run "plans_no_textract_access_with_ocr_off" {
  command = plan

  variables {
    ocr_enabled = false
  }

  assert {
    condition     = [for statement in data.aws_iam_policy_document.document_extraction.statement : statement.sid] == ["WriteOwnLogs", "VpcNetworking"]
    error_message = "With OCR off the role must not be allowed to call Textract."
  }

  assert {
    condition = (
      length(data.aws_vpc_endpoint_service.textract) == 0 &&
      length(aws_vpc_endpoint.textract) == 0 &&
      length(aws_security_group.textract_endpoint) == 0 &&
      length(aws_vpc_security_group_ingress_rule.textract_endpoint_from_extraction) == 0 &&
      length(aws_vpc_security_group_egress_rule.document_extraction_textract) == 0
    )
    error_message = "With OCR off the module must plan no Textract endpoint, security group, or rule."
  }

  assert {
    condition     = length(aws_lambda_function.document_extraction.environment) == 0
    error_message = "With OCR off the function must get no Textract endpoint."
  }
}

run "plans_a_private_textract_endpoint_for_ocr_inside_the_vpc" {
  command = plan

  variables {
    ocr_enabled = true
  }

  assert {
    condition     = [for statement in data.aws_iam_policy_document.document_extraction.statement : statement.sid] == ["WriteOwnLogs", "VpcNetworking", "RecognizeScannedPages"]
    error_message = "With OCR on the role must gain exactly one Textract statement after its network statement."
  }

  assert {
    condition = (
      data.aws_iam_policy_document.document_extraction.statement[2].actions == toset(["textract:DetectDocumentText"]) &&
      data.aws_iam_policy_document.document_extraction.statement[2].resources == toset(["*"]) &&
      one(data.aws_iam_policy_document.document_extraction.statement[2].condition).test == "StringEquals" &&
      one(data.aws_iam_policy_document.document_extraction.statement[2].condition).variable == "aws:RequestedRegion" &&
      one(data.aws_iam_policy_document.document_extraction.statement[2].condition).values == tolist(["us-east-2"])
    )
    error_message = "The role may call only DetectDocumentText, and only in the install's Region."
  }

  assert {
    condition = (
      aws_vpc_endpoint.textract[0].vpc_endpoint_type == "Interface" &&
      aws_vpc_endpoint.textract[0].service_name == "com.amazonaws.us-east-2.textract" &&
      aws_vpc_endpoint.textract[0].private_dns_enabled == true &&
      aws_vpc_endpoint.textract[0].vpc_id == "vpc-00000000000000001" &&
      aws_vpc_endpoint.textract[0].subnet_ids == toset(["subnet-00000000000000001", "subnet-00000000000000002"])
    )
    error_message = "OCR inside the VPC must plan an interface endpoint in the private subnets whose private DNS answers for Textract's public name."
  }

  assert {
    condition = (
      one(data.aws_iam_policy_document.textract_endpoint[0].statement).actions == toset(["textract:DetectDocumentText"]) &&
      one(one(data.aws_iam_policy_document.textract_endpoint[0].statement).condition).test == "ArnEquals" &&
      one(one(data.aws_iam_policy_document.textract_endpoint[0].statement).condition).variable == "aws:PrincipalArn"
    )
    error_message = "The endpoint policy must admit only the function's role, and only DetectDocumentText."
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.document_extraction_textract[0].ip_protocol == "tcp" &&
      aws_vpc_security_group_egress_rule.document_extraction_textract[0].from_port == 443 &&
      aws_vpc_security_group_egress_rule.document_extraction_textract[0].to_port == 443 &&
      aws_vpc_security_group_ingress_rule.textract_endpoint_from_extraction[0].ip_protocol == "tcp" &&
      aws_vpc_security_group_ingress_rule.textract_endpoint_from_extraction[0].from_port == 443 &&
      aws_vpc_security_group_ingress_rule.textract_endpoint_from_extraction[0].to_port == 443
    )
    error_message = "The function must reach the endpoint, and the endpoint accept the function, on TCP 443 only."
  }

  assert {
    condition     = aws_lambda_function.document_extraction.environment[0].variables == tomap({ DEPLOYMENTS_AI_TEXTRACT_ENDPOINT = "https://textract.us-east-2.amazonaws.com" })
    error_message = "With OCR on the function must get the Region's Textract host as an HTTPS URL, known at plan time."
  }
}

run "plans_the_regional_textract_endpoint_for_ocr_outside_a_vpc" {
  command = plan

  variables {
    network     = null
    ocr_enabled = true
  }

  assert {
    condition     = [for statement in data.aws_iam_policy_document.document_extraction.statement : statement.sid] == ["WriteOwnLogs", "RecognizeScannedPages"]
    error_message = "Outside a VPC the role must gain the Textract statement and no network statement."
  }

  assert {
    condition     = length(aws_vpc_endpoint.textract) == 0 && length(aws_security_group.textract_endpoint) == 0
    error_message = "Outside a VPC OCR must plan no interface endpoint."
  }

  assert {
    condition     = aws_lambda_function.document_extraction.environment[0].variables == tomap({ DEPLOYMENTS_AI_TEXTRACT_ENDPOINT = "https://textract.us-east-2.amazonaws.com" })
    error_message = "Outside a VPC the function must call the Region's public Textract endpoint."
  }
}
