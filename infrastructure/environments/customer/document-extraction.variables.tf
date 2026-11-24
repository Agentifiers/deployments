variable "document_extraction_artifact_bucket" {
  description = "S3 bucket containing the document extraction Lambda artifact; set by the deploy tool."
  type        = string
  default     = ""
}

variable "document_extraction_artifact_key" {
  description = "S3 key containing the document extraction Lambda artifact; set by the deploy tool."
  type        = string
  default     = ""
}

variable "document_extraction_artifact_version" {
  description = "Immutable S3 object version of the document extraction Lambda artifact; set by the deploy tool."
  type        = string
  default     = ""
}

variable "document_extraction_ocr_enabled" {
  description = "Whether document extraction reads PDF pages that have no text layer with Amazon Textract DetectDocumentText. Off by default because it sends page images to AWS, which may use them unless your AWS Organization applies an AI services opt-out policy, and because it adds Textract charges and, inside the VPC, an interface endpoint. The plan fails in a Region without Textract."
  type        = bool
  default     = false
}
