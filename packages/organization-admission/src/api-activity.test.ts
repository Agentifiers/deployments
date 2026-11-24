import { PUBLIC_API_ROUTES } from "@deployments-ai/api-contract/product";
import { describe, expect, test } from "bun:test";
import { apiRequestClassifier } from "./api-activity.ts";

const classify = apiRequestClassifier(PUBLIC_API_ROUTES);
const ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0A";

describe("classifying public API requests by their route contract", () => {
  test("reads, declared remediations, erasures, and system routes each get their activity", () => {
    const requests = [
      ["GET", "/v1/projects"],
      ["HEAD", "/v1/projects"],
      ["POST", "/v1/projects"],
      ["DELETE", `/v1/api-keys/${ID}`],
      ["POST", `/v1/api-keys/${ID}/rotate`],
      ["DELETE", `/v1/members/${ID}`],
      ["DELETE", `/v1/organizations/${ID}/model-credentials/openai`],
      ["PUT", `/v1/organizations/${ID}/model-credentials/openai`],
      ["PATCH", `/v1/budgets/${ID}`],
      ["POST", `/v1/runs/${ID}/cancel`],
      ["POST", "/v1/runs/search"],
      ["POST", "/v1/memory/search"],
      ["POST", `/v1/organizations/${ID}/erasures`],
      ["PUT", `/v1/system/organizations/${ID}/holds/payment-overdue`],
      ["POST", "/v1/not-a-route"],
    ] as const;

    expect(requests.map(([method, path]) => `${method} ${path} ${classify(method, path)}`)).toEqual(
      [
        "GET /v1/projects api.read",
        "HEAD /v1/projects api.read",
        "POST /v1/projects api.write",
        `DELETE /v1/api-keys/${ID} api.remediate`,
        `POST /v1/api-keys/${ID}/rotate api.write`,
        `DELETE /v1/members/${ID} api.remediate`,
        `DELETE /v1/organizations/${ID}/model-credentials/openai api.remediate`,
        `PUT /v1/organizations/${ID}/model-credentials/openai api.write`,
        `PATCH /v1/budgets/${ID} api.remediate`,
        `POST /v1/runs/${ID}/cancel api.remediate`,
        "POST /v1/runs/search api.read",
        "POST /v1/memory/search api.read",
        `POST /v1/organizations/${ID}/erasures api.erase`,
        `PUT /v1/system/organizations/${ID}/holds/payment-overdue api.operate`,
        "POST /v1/not-a-route api.write",
      ],
    );
  });

  test("access links distribute, a memory delete erases, and a memory space archive remediates", () => {
    const requests = [
      ["POST", `/v1/artifacts/${ID}/access-urls`],
      ["POST", `/v1/agent-email/messages/${ID}/raw/access`],
      ["POST", `/v1/agent-email/attachments/${ID}/access-url`],
      ["POST", `/v1/memory/${ID}/delete`],
      ["DELETE", `/v1/memory-spaces/${ID}`],
      ["POST", `/v1/organizations/${ID}/data-exports`],
    ] as const;

    expect(requests.map(([method, path]) => `${method} ${path} ${classify(method, path)}`)).toEqual(
      [
        `POST /v1/artifacts/${ID}/access-urls api.distribute`,
        `POST /v1/agent-email/messages/${ID}/raw/access api.distribute`,
        `POST /v1/agent-email/attachments/${ID}/access-url api.distribute`,
        `POST /v1/memory/${ID}/delete api.erase`,
        `DELETE /v1/memory-spaces/${ID} api.remediate`,
        `POST /v1/organizations/${ID}/data-exports api.read`,
      ],
    );
  });
});
