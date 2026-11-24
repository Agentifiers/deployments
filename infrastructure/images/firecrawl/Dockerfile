FROM ghcr.io/agentifiers/firecrawl:1.0.0@sha256:8154a998882676a04bb745d947e62a6954336873ac6ff11bd2a027ab8830775e AS firecrawl

# The release build exports this stage: the DynamoDB table definition of exactly this image.
FROM scratch AS dynamodb-table
COPY --from=firecrawl /app/dynamodb-table.json /dynamodb-table.json

FROM firecrawl
