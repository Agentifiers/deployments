# infrastructure/modules/app-runtime

Hosts agent-built apps under `domain` and `*.<domain>`: an Aurora PostgreSQL Serverless v2
cluster for app databases, the `apps-database` Lambda that provisions, migrates, queries,
exports, and erases those databases, an S3 bucket for release files and exports, an ECS Fargate
app gateway, a CloudFront distribution that routes each app subdomain to its release assets
or to the gateway, a multi-tenant CloudFront distribution that does the same for app domains
outside `domain`, and the `apps-domains` Lambda that converges that distribution's tenants to
app domain records.

`modules/platform` (`apps.tf`) instantiates it as `module.app_runtime` when `apps_enabled` is
true. See `variables.tf` and `outputs.tf` for inputs and outputs.

## Resources and security behavior

- Database: Aurora PostgreSQL 17 with storage encryption, `rds.force_ssl = 1`, IAM database
  authentication, an RDS-managed master password, the Data API enabled, 7-day backups, and
  deletion protection plus a final snapshot when `deletion_protection_enabled` is true. The
  cluster accepts 5432 only from two client security groups (the database Lambda and the
  gateway), which may egress only to the cluster and HTTPS.
- IAM (all roles carry `permissions_boundary`): the database Lambda may `rds-db:connect` as the
  provisioner and per-app owner/viewer users; the gateway task only as per-app
  viewer/editor/visitor users (`packages/app-database/README.md` lists what each role may do).
  Callers receive policies to invoke the database Lambda, read exports, presign create-only
  release uploads (`s3:if-none-match` required), and create `APP-SESSION#` items.
- OAuth client secret: the SecureString parameter `/identity/apps-<environment>-oauth-client`,
  which the identity client bootstrap writes. OpenTofu only names it, so the value never reaches
  state. The gateway task role may `ssm:GetParameter` it.
- Bucket: `apps-<environment>-<account id>`, full public access block, SSE-S3,
  `BucketOwnerEnforced`, TLS-only policy. CloudFront may read only `apps/*/releases/*`, and
  only through the origin access control of the two distributions. `force_destroy` is the
  inverse of `deletion_protection_enabled`.
- Edge certificates: a us-east-1 certificate for CloudFront and a regional certificate for the
  gateway's HTTPS listener (TLS 1.3/1.2 policy, port 9443) on the shared internal ALB, reached
  through a CloudFront VPC origin.
- Distributions: `aws_cloudfront_distribution.apps` serves `domain` and `*.<domain>`.
  `aws_cloudfront_multitenant_distribution.custom_domains` serves app domains in tenant-only
  mode. Each app domain is a distribution tenant in the connection group
  `aws_cloudfront_connection_group.custom_domains` (IPv6 on), with the required tenant
  parameter `appId`. The apps edge certificate is the distribution's template certificate. It
  does not name an app domain, so a domain serves traffic only after its tenant gets its own
  certificate. Both distributions read their two origins (`gateway`, the VPC origin, and
  `releases`, the S3 bucket) and their two behaviors (`/_r/*` to `releases`, the default to
  `gateway`) from the `edge_origins` and `edge_behaviors` locals in `edge.tf`. OpenTofu does
  not create or track tenants; the `apps-domains` Lambda does.
- Viewer-request function (`viewer-request.js`), shared by both distributions. It answers 403
  to `Service-Worker: script` and deletes any client copy of `x-deployments-app-id`,
  `x-deployments-app-host`, and `x-deployments-viewer-address`. Then it picks the app:
  - A request through the multi-tenant distribution carries `event.context.endpoint`. When it
    does and the host is neither `domain` nor under it, the function treats it as a tenant
    request and reads the app from the tenant's `appId` parameter, answering 404 if it cannot.
    A request bound for the gateway also gets `x-deployments-app-host` (the lowercased viewer
    host), and the function selects the `gateway` origin with `allowedCertificateNames`
    `*.<domain>`. Without that, CloudFront checks the gateway certificate against the custom
    domain and answers 502. The apex and `<slug>.<domain>` keep the rules below even when an
    endpoint is set.
  - On the apex of `domain`, only `/_platform/auth/callback` and `/_platform/healthz` pass, with
    no app headers.
  - On `<slug>.<domain>`, the function resolves the slug through the CloudFront KeyValueStore
    and answers 404 for an unknown slug or a deeper host.
  - On either app path, `/_r/<release>/<path>` is rewritten to the app's release prefix, and
    a document path (the `document_extensions` local), an empty, `.`, or `..` segment, or a
    malformed escape gets 404. Every other request goes to the gateway with
    `x-deployments-app-id` and `x-deployments-viewer-address` (`event.viewer.ip`).
- Response headers: one CSP string (the `content_security_policy` local), `nosniff`,
  `strict-origin-when-cross-origin`, and HSTS for one year, all overriding app values.
  `aws_cloudfront_response_headers_policy.apps` sends HSTS with `includeSubDomains`.
  `aws_cloudfront_response_headers_policy.custom_domains`, used by the multi-tenant
  distribution, omits it, because an app domain can be a customer's apex.
- Gateway tasks run in private subnets without public IPs and accept traffic only from the
  load balancer security group.
- Domain reconciler (`domain-reconciler.tf`): the `apps-domains` Lambda (Node.js 26, arm64,
  512 MB, 300 s, outside the VPC) is the only CloudFront and ACM writer for app domains. Its
  reserved concurrency of 1 makes runs never overlap: every caller invokes it asynchronously,
  and Lambda keeps a throttled event queued until the running one ends. The reservation counts
  against the account's Lambda concurrency quota in the deployment region, and Lambda keeps 100
  of that quota unreserved, so the apply fails where the quota is the new-account default of 10.
  The function's event invoke config sets `maximum_retry_attempts = 0` and `maximum_event_age_in_seconds = 600`: the 5-minute schedule
  is the retry, so a failed run is not run again, and an event older than two sweeps is dropped
  instead of holding the only slot. A sweep starts no step after 240 s and leaves the rest to the
  next sweep (`DeferredReconcileSteps`), so the step in flight ends inside the 300 s timeout. A
  domain in steady state costs a sweep no CloudFront call, and creates and certificate requests
  are capped by the daily budgets below. It reads the multi-tenant distribution and connection
  group IDs, the control, events, and usage table names, and the two daily budgets from its
  environment, and refuses to start when a budget is not a whole number of at least 1.
  EventBridge Scheduler invokes it asynchronously every 5 minutes (`apps-domains`, input
  `{"kind":"sweep"}`, no flexible window, 2 retries within 300 s) through the
  `apps-domains-scheduler` role, which may only invoke it and send to the
  `apps-domains-schedule-dlq` dead-letter queue (SSE, 14 days). Four alarms notify
  `alarm_topic_arn`: Lambda `Errors` above 0 in 2 of 3 5-minute periods, any visible message in
  the dead-letter queue, `PlatformCertificateBudgetRefusedDomains` (namespace
  `DeploymentsAI/Apps`) above 0 in a 5-minute period, and `DeferredReconcileSteps` with a
  `Minimum` above 0 in 3 consecutive 5-minute periods. Every sweep visits domains, then drains,
  then certificates, so sweeps that keep running out of time leave the same steps at the end,
  usually drains and certificate cleanup, undone. Each sweep also reports
  `OrganizationCertificateBudgetRefusedDomains`, which has no alarm: an organization that spends
  its own budget sees `organization_certificate_limit` on its domains, while a spent platform
  budget holds back every organization. A sweep fails only when its snapshot or a CloudFront,
  ACM, or DynamoDB call fails; a domain the edge rejects or a budget holds back gets a `problem`
  instead. Both roles carry `permissions_boundary`.
- Reconciler IAM: it creates tenants and tags them and their ACM certificates only with
  `deployments:managed-by=apps` as the sole tag key, and updates or deletes only tenants, and
  deletes only us-east-1 certificates, that carry that tag. Tenant and certificate reads, tenant
  and certificate listing, and `acm:RequestCertificate` (CloudFront requests a tenant's managed
  certificate with the caller's credentials, before any tag exists) are not tag-scoped: the
  reconciler must see untagged tenants to report a hostname another tenant already serves, and
  must read a tenant's tags before it knows the tenant is its own. `cloudfront:GetVpcOrigin` on
  the gateway VPC origin backs tenant creates and updates. DynamoDB access is limited by
  `dynamodb:LeadingKeys`: `GetItem` of app-domain records (`ORG#*#APP#*`) and `UNIQUE#app-id`
  claims, `Query` of `UNIQUE#app-hostname`; `GetItem` of the `GLOBAL#deploy-migration`
  shard-writes marker that decides where governance inventory rows go; `GetItem` of the
  organization partition `ORG#<id>` alone, for the retention policy that sets each semantic
  event's item TTL; puts of app-domain
  records and their governance inventory rows; condition checks of the app, the organization
  fence, and the domain's unique claims; `app-domain` semantic events; and reads and puts of the
  certificate request counters (`SCOPE#*` in the usage table). No `Scan`, and no
  `cloudwatch:PutMetricData`: metrics are Embedded Metric Format log lines.
- Rejected creates: no API can check a customer hostname for conflicts before the create.
  `cloudfront:ListDomainConflicts` needs a standard distribution or a tenant whose certificate
  already covers the hostname, and it answers `InvalidArgument` for a multi-tenant distribution
  (measured). CloudFront requests a tenant's managed certificate before it checks the hostname,
  so a create that answers `CNAMEAlreadyExists` leaves an untagged certificate behind
  (measured for a holder on the same and on another distribution). A create whose hostname does
  not point at CloudFront answers `InvalidArgument` and requests no certificate (measured); the
  domain gets `edge_rejected`. Before it creates, a sweep looks for a holder among every tenant
  in the account, and a single-domain run asks CloudFront for an active holder.
- Create backoff: after a rejected create the next one for that domain, by sweep or refresh,
  waits 10 minutes, then 20, 40, and so on up to one a day, until a create succeeds. The domain
  record keeps the count and the time of the latest rejection in `problem.rejectedCreates`, and
  the wait counts from that time, so recording the problem again, or a different one, never
  moves it. Every problem change except `previous_tenant_draining` keeps the count. Detaching and
  attaching a hostname again starts a new record with no backoff, which the budgets below cover.
- Certificate request budgets: every call that makes CloudFront request a certificate (a tenant
  create, a request for a tenant with no managed certificate, and a renewal on refresh) first
  takes one request from the domain's organization and one from the platform for the current
  UTC day, in one DynamoDB transaction on two `rate-limit-counter` items in the usage table
  (`limitKey` `app-domain.certificate-request`, scope the organization or the zero ULID). Each
  put is conditioned on the version it read, so no counter passes its limit. The counters are
  keyed by organization, not by domain, so detaching and attaching again does not refill them.
  When either budget is spent the reconciler requests nothing and records
  `organization_certificate_limit` or `platform_certificate_limit`, whose message gives the next
  00:00 UTC. A create takes from the budgets only once its backoff has ended, so the backoff
  never holds it longer. The next sweep after that time requests the certificate on its own, a
  refused renewal included. When a budget refuses again after that time, the reconciler records
  the problem again with the new time and leaves `rejectedCreates` as it was. The worst case is
  the budget itself: 5 × 365 = 1,825 requests a year for one organization and 12 × 365 = 4,380 for the
  platform, under ACM's default quota of 5,000 certificates created per account in 365 days.
  Raise that ACM quota in us-east-1 before you raise `domain_certificate_requests_per_day`,
  and keep the budget times 365 below it, because a refused request is never sent and a
  granted one is spent even when CloudFront then rejects the create.
- Certificate cleanup: after a create that did not create the tenant, the reconciler tags each
  CloudFront-managed certificate for that hostname that ACM lists as requested during the
  attempt, from 5 seconds before it began to 5 seconds after it ended. ACM's listing is not
  read-after-write consistent: it showed a new certificate up to 1.6 s after the create returned
  (measured, 2 of 20 creates missed by the first listing). When the listing right after the
  create finds no certificate, the domain record keeps the attempt's window in
  `state.certificateSearches`, and each sweep looks for a certificate requested in that window
  in its own listing. It drops the window once it tags a certificate, or an hour after the
  attempt ended. Each sweep deletes a tagged certificate that is not in use, that no tenant in
  the account has attached, and that is not the managed certificate of any listed tenant for
  that hostname or of the tenant of any published domain
  with that hostname, which the sweep reads by name in case the listing misses it. A failed
  domain step does not hold the cleanup back. Two risks remain. A certificate someone else
  requests for the same hostname inside that window, for a tenant that does not exist yet when
  the next sweep lists tenants, is deleted. A certificate that ACM lists more than an hour late,
  or whose domain is detached or erased while its window is pending, stays untagged and counts
  against the account's ACM certificate quota until an operator deletes it. The second needs a
  first listing that misses the certificate (5 of 62 rejected creates on real AWS, measured)
  and a detach within the hour.
- Untagged certificates: each sweep reports `UntaggedIdleCertificates`, the CloudFront-managed
  certificates more than two hours old that carry no `deployments:managed-by` tag, are not in
  use, and that no listed tenant has attached or requested. The reconciler never deletes them,
  and the metric has no alarm. A foreign tenant's leftover certificate counts too. The
  [troubleshooting guide](../../../apps/docs/content/docs/operate/troubleshooting.mdx) shows how
  to clean them up.

## Gateway visitor limits

`local.gateway_environment` in `gateway.tf` sets the visitor limits; the module has no input for
them. `apps/app-gateway/src/config.ts` validates them, and the
[apps guide](<../../../apps/docs/content/docs/(guides)/capabilities/apps.mdx>) documents what a
visitor meets.

## Gateway custom hosts and sign-in

- A request with `x-deployments-app-host` serves only when that hostname's global `app-hostname`
  claim belongs to an `active` `app-domain` of the app in `x-deployments-app-id`. Anything else
  gets 404 before the gateway reads the app, a session, or the app database. Each task caches
  the hostname lookup, hit or miss, for 5 seconds in a cache of at most 10,000 entries, so a
  detach stops page and API service within 5 seconds. `/_r/` requests never reach the gateway
  and keep serving until the tenant is disabled.
- Sign-in on a custom host runs only when the domain's `attachedBy` is a person (`principal`).
  On a domain an API key attached, `/_platform/auth/login` answers 302 to the same path on
  `<slug>.<domain>`, `/_platform/auth/complete` refuses, and every route, logout included, ignores
  the session cookie. A session from an earlier person-attached domain of that hostname therefore
  stops working, and sign-out there neither checks fetch metadata nor deletes it. Bearer tokens
  still count, so a bearer call keeps its exemption from the same-origin check, and a bearer
  session, which is bound to the slug host, is refused as on any other custom host.
- The login transaction and its handoff record the host the login started on. The callback
  stays on the apex, so the identity provider client keeps one redirect URI,
  `https://<domain>/_platform/auth/callback`. The callback reads the domain again, without the
  cache, and redirects only to the slug host or to a custom host that still passes the rule
  above. Otherwise it answers 403 with a link to sign in on the slug host. The handoff redeems
  only on its recorded host, and the session it creates is bound to that host.

## Teardown

The [teardown guide](../../../apps/docs/content/docs/operate/teardown.mdx) covers draining app
domain tenants and the CloudFront default connection group that outlives a destroy.

## Tests

No `*.tftest.hcl` files in this module. `tests/app-runtime-infrastructure.test.ts` and
`tests/app-domain-reconciler-infrastructure.test.ts` (Bun) read this module's source, and
`tests/app-runtime-viewer-request.test.ts` runs `viewer-request.js` with the CloudFront runtime
objects it uses replaced by fakes.
