moved {
  from = aws_s3tables_table.semantic_events_dev
  to   = aws_s3tables_table.semantic_events_unprotected
}

moved {
  from = aws_glue_catalog.s3tables_dev
  to   = aws_glue_catalog.s3tables_unprotected
}

moved {
  from = aws_kms_key.artifacts_dev
  to   = aws_kms_key.artifacts_unprotected
}

moved {
  from = aws_kms_key.artifacts_unprotected
  to   = aws_kms_key.data_unprotected
}

moved {
  from = aws_kms_key.artifacts_protected
  to   = aws_kms_key.data_protected
}

moved {
  from = aws_kms_alias.artifacts
  to   = aws_kms_alias.data
}

moved {
  from = aws_s3_bucket.artifacts_dev
  to   = aws_s3_bucket.artifacts_unprotected
}

moved {
  from = aws_s3_bucket.governance_dev
  to   = aws_s3_bucket.governance_unprotected
}

moved {
  from = aws_kms_key.governance_signing_dev
  to   = aws_kms_key.governance_signing_unprotected
}

moved {
  from = aws_s3tables_table.agent_observability_dev
  to   = aws_s3tables_table.agent_observability_unprotected
}
