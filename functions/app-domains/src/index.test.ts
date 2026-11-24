import { expect, test } from "bun:test";
import { APP_DOMAINS_ENV, readConfiguration } from "./index.ts";

const VALID = {
  [APP_DOMAINS_ENV.certificateRequestsPerDay]: "12",
  [APP_DOMAINS_ENV.certificateRequestsPerOrganizationPerDay]: "5",
  [APP_DOMAINS_ENV.connectionGroupId]: "cg_example",
  [APP_DOMAINS_ENV.distributionId]: "E2EXAMPLE",
};

test("reads each daily certificate request budget from its own variable", () => {
  expect(readConfiguration(VALID)).toEqual({
    certificateRequestLimits: { organization: 5, platform: 12 },
    connectionGroupId: "cg_example",
    distributionId: "E2EXAMPLE",
  });
});

test.each([
  [APP_DOMAINS_ENV.certificateRequestsPerDay, "0"],
  [APP_DOMAINS_ENV.certificateRequestsPerDay, "2.5"],
  [APP_DOMAINS_ENV.certificateRequestsPerOrganizationPerDay, "five"],
  [APP_DOMAINS_ENV.certificateRequestsPerOrganizationPerDay, undefined],
])("refuses to start when %s is %p", (name, value) => {
  expect(() => readConfiguration({ ...VALID, [name]: value })).toThrow(name);
});
