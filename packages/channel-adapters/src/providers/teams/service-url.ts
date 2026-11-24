export const TEAMS_DEFAULT_SERVICE_URL = "https://smba.trafficmanager.net/teams/";

const ALLOWED_TEAMS_SERVICE_HOSTNAME = "smba.trafficmanager.net";
export const TEAMS_CONNECTOR_ORIGIN = `https://${ALLOWED_TEAMS_SERVICE_HOSTNAME}`;
const MAX_TEAMS_SERVICE_URL_CHARACTERS = 2_048;

/**
 * Validates a Bot Connector service URL and returns it with a trailing slash. Only the
 * commercial-cloud Teams connector host over HTTPS is accepted; government clouds use different
 * token authorities and are unsupported.
 */
export function normalizeTeamsServiceUrl(value: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_TEAMS_SERVICE_URL_CHARACTERS) {
    throw new TypeError("Teams service URL is required.");
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError("Teams service URL must be a valid URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== ALLOWED_TEAMS_SERVICE_HOSTNAME ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Teams service URL is not an allowed Bot Connector endpoint.");
  }
  const pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return `${url.origin}${pathname}`;
}

export function allowedTeamsServiceUrl(value: string): string | undefined {
  try {
    return normalizeTeamsServiceUrl(value);
  } catch {
    return undefined;
  }
}
