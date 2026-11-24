variable "document_extraction_artifact_bucket" {
  description = "S3 bucket containing the document extraction Lambda artifact."
  type        = string
}

variable "document_extraction_artifact_key" {
  description = "S3 key containing the document extraction Lambda artifact."
  type        = string
}

variable "document_extraction_artifact_version" {
  description = "Immutable S3 object version of the document extraction Lambda artifact."
  type        = string
}

variable "document_extraction_ocr_enabled" {
  description = "Whether document extraction reads PDF pages that have no text layer with Amazon Textract."
  type        = bool
}
