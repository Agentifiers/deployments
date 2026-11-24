import cf from "cloudfront";

const appHosts = cf.kvs();
const appsDomain = "${apps_domain}";
const apexPaths = ["/_platform/auth/callback", "/_platform/healthz"];
const edgeHeaders = [
  "x-deployments-app-id",
  "x-deployments-app-host",
  "x-deployments-viewer-address",
];
const releasePath = /^\/_r\/([0-9A-HJKMNP-TV-Z]{26})\/(.+)$/;
const documentPath = /\.(?:${document_extensions})$/i;

function reject(statusCode, statusDescription) {
  return { statusCode, statusDescription };
}

// S3 decodes the key once, so the path is judged decoded.
function isAssetPath(path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
    // oxlint-disable-next-line no-unused-vars -- the runtime's ES 5.1 catch requires a binding.
  } catch (malformedEscape) {
    return false;
  }
  if (documentPath.test(decoded)) return false;
  return decoded
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function releaseRequest(request, appId) {
  const release = releasePath.exec(request.uri);
  if (!release || !isAssetPath(release[2])) return reject(404, "Not Found");
  request.uri = "/apps/" + appId + "/releases/" + release[1] + "/" + release[2];
  return request;
}

function gatewayRequest(event, appId) {
  const request = event.request;
  request.headers["x-deployments-app-id"] = { value: appId };
  request.headers["x-deployments-viewer-address"] = { value: event.viewer.ip };
  return request;
}

function tenantRequest(event, host) {
  const request = event.request;
  let appId;
  try {
    appId = cf.distributionTenant.parameters.get("appId");
    // oxlint-disable-next-line no-unused-vars -- the runtime's ES 5.1 catch requires a binding.
  } catch (missingParameter) {
    return reject(404, "Not Found");
  }
  if (request.uri.startsWith("/_r/")) return releaseRequest(request, appId);

  request.headers["x-deployments-app-host"] = { value: host };
  // The viewer's host is the customer's domain, which the gateway certificate does not name.
  cf.selectRequestOriginById("gateway", { allowedCertificateNames: ["*." + appsDomain] });
  return gatewayRequest(event, appId);
}

// oxlint-disable-next-line no-unused-vars -- CloudFront invokes handler by name.
async function handler(event) {
  const request = event.request;
  const serviceWorker = request.headers["service-worker"];
  if (serviceWorker && serviceWorker.value === "script") return reject(403, "Forbidden");
  edgeHeaders.forEach((name) => delete request.headers[name]);

  const host = request.headers.host.value.toLowerCase();
  const onAppsDomain = host === appsDomain || host.endsWith("." + appsDomain);
  // Only a multi-tenant distribution sets context.endpoint, and no app domain is under the apps domain.
  if (event.context.endpoint && !onAppsDomain) return tenantRequest(event, host);
  if (host === appsDomain) {
    return apexPaths.includes(request.uri) ? request : reject(404, "Not Found");
  }

  const slug = onAppsDomain ? host.slice(0, -appsDomain.length - 1) : "";
  if (slug === "" || slug.includes(".")) return reject(404, "Not Found");
  let appId;
  try {
    appId = await appHosts.get(slug);
    // oxlint-disable-next-line no-unused-vars -- the runtime's ES 5.1 catch requires a binding.
  } catch (missingKey) {
    return reject(404, "Not Found");
  }

  if (request.uri.startsWith("/_r/")) return releaseRequest(request, appId);
  return gatewayRequest(event, appId);
}
