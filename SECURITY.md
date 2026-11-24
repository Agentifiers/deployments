# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub private vulnerability reporting:
<https://github.com/Agentifiers/deployments/security/advisories/new>.

Do not open public issues for suspected vulnerabilities.

Include what you can of:

- the affected component, version, or commit;
- steps to reproduce or a proof of concept;
- the impact you observed or expect.

## Scope

In scope: the code in this repository, including the platform services, functions, console, CLI, SDK,
OpenTofu modules and roots, the `terraform-provider-deployments` provider, and the container images
built from this repository.

Out of scope: third-party services and images this platform runs or calls (for example Firecrawl,
Lightpanda, SearXNG, Bifrost, and model providers). Report those to their maintainers. Issues that
exist only in a specific operator's deployment configuration belong with that operator.

## What to expect

We will acknowledge your report, investigate, and keep you updated in the advisory thread. When a fix
ships we will publish a GitHub security advisory and credit you unless you prefer otherwise. Please give
us a reasonable opportunity to fix the issue before disclosing it publicly.
