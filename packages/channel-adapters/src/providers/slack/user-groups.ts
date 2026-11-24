export type SlackUserGroupStatus = "active" | "disabled";

export interface SlackUserGroup {
  readonly description?: string;
  readonly handle: string;
  readonly id: string;
  readonly name: string;
  readonly status: SlackUserGroupStatus;
  readonly teamId?: string;
  readonly userIds?: readonly string[];
}

export interface SlackUserGroupDesiredState {
  readonly description?: string;
  readonly handle: string;
  readonly name: string;
  readonly status: SlackUserGroupStatus;
  readonly teamId?: string;
}

export interface SlackUserGroupClient {
  readonly create: (desired: SlackUserGroupDesiredState) => Promise<SlackUserGroup>;
  readonly disable: (id: string, teamId?: string) => Promise<SlackUserGroup>;
  readonly enable: (id: string, teamId?: string) => Promise<SlackUserGroup>;
  readonly list: (teamId?: string) => Promise<readonly SlackUserGroup[]>;
  readonly update: (id: string, desired: SlackUserGroupDesiredState) => Promise<SlackUserGroup>;
}

export type SlackUserGroupFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class SlackUserGroupApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}.`);
    this.name = "SlackUserGroupApiError";
  }
}

type SlackUserGroupAction = "disabled" | "enabled" | "updated";

const MAX_HANDLE_CHARACTERS = 80;
const MAX_NAME_CHARACTERS = 80;
const MAX_DESCRIPTION_CHARACTERS = 255;
const MAX_ID_CHARACTERS = 64;
const REQUEST_TIMEOUT_MS = 10_000;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function boundedText(value: string, label: string, maximumCharacters: number) {
  const text = value.trim();
  if (!text) throw new TypeError(`Slack user-group ${label} must not be empty.`);
  if (Array.from(text).length > maximumCharacters) {
    throw new TypeError(
      `Slack user-group ${label} must not exceed ${String(maximumCharacters)} characters.`,
    );
  }
  if (
    Array.from(text).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new TypeError(`Slack user-group ${label} must not contain control characters.`);
  }
  return text;
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function userGroupId(value: string) {
  const id = boundedText(value, "ID", MAX_ID_CHARACTERS);
  if (!/^S[A-Z0-9]+$/u.test(id)) {
    throw new TypeError(
      "Slack user-group ID must start with S and contain uppercase letters or digits.",
    );
  }
  return id;
}

function slackUserId(value: unknown) {
  const id = boundedText(typeof value === "string" ? value : "", "user ID", MAX_ID_CHARACTERS);
  if (!/^[UW][A-Z0-9]+$/u.test(id)) {
    throw new TypeError(
      "Slack user ID must start with U or W and contain uppercase letters or digits.",
    );
  }
  return id;
}

function desiredState(value: SlackUserGroupDesiredState) {
  if (value.status !== "active" && value.status !== "disabled") {
    throw new TypeError("Slack user-group status must be active or disabled.");
  }
  const handle = boundedText(value.handle, "handle", MAX_HANDLE_CHARACTERS).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(handle)) {
    throw new TypeError(
      "Slack user-group handle must contain lowercase letters, digits, underscores, or hyphens.",
    );
  }
  const teamId = value.teamId ? boundedText(value.teamId, "team ID", MAX_ID_CHARACTERS) : undefined;
  if (teamId && !/^T[A-Z0-9]+$/u.test(teamId)) {
    throw new TypeError(
      "Slack user-group team ID must start with T and contain uppercase letters or digits.",
    );
  }
  return {
    ...(value.description
      ? { description: boundedText(value.description, "description", MAX_DESCRIPTION_CHARACTERS) }
      : {}),
    handle,
    name: boundedText(value.name, "name", MAX_NAME_CHARACTERS),
    status: value.status,
    ...(teamId ? { teamId } : {}),
  };
}

function normalizedUserGroup(value: unknown, requireUsers = false): SlackUserGroup {
  const source = record(value, "Slack user-group response");
  const id = userGroupId(typeof source.id === "string" ? source.id : "");
  const rawStatus = optionalText(source.status);
  const dateDelete = source.date_delete;
  const description = optionalText(source.description);
  const status =
    rawStatus === "disabled" ||
    (typeof dateDelete === "number" && Number.isFinite(dateDelete) && dateDelete > 0)
      ? "disabled"
      : "active";
  const teamId = optionalText(source.team_id);
  if (requireUsers && !Array.isArray(source.users)) {
    throw new TypeError("Slack user-group list response must include users.");
  }
  const userIds = Array.isArray(source.users) ? source.users.map(slackUserId) : undefined;
  return {
    ...(description ? { description } : {}),
    handle: boundedText(
      typeof source.handle === "string" ? source.handle : "",
      "handle",
      MAX_HANDLE_CHARACTERS,
    ),
    id,
    name: boundedText(
      typeof source.name === "string" ? source.name : "",
      "name",
      MAX_NAME_CHARACTERS,
    ),
    status,
    ...(teamId ? { teamId } : {}),
    ...(userIds ? { userIds } : {}),
  };
}

function desiredBody(desired: ReturnType<typeof desiredState>, includeEmptyDescription = false) {
  return {
    ...(desired.description || includeEmptyDescription
      ? { description: desired.description ?? "" }
      : {}),
    handle: desired.handle,
    name: desired.name,
    ...(desired.teamId ? { team_id: desired.teamId } : {}),
  };
}

function lifecycleBody(id: string, teamId?: string) {
  return {
    ...(teamId ? { team_id: teamId } : {}),
    usergroup: userGroupId(id),
  };
}

export function slackUserGroupClient(options: {
  readonly fetch?: SlackUserGroupFetch;
  readonly token: string;
}): SlackUserGroupClient {
  const token = boundedText(options.token, "access token", 4_096);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("Fetch is unavailable.");

  async function request(method: string, input?: Readonly<Record<string, unknown>>) {
    const query = method === "usergroups.list" ? new URLSearchParams() : undefined;
    if (query) {
      query.set("include_disabled", "true");
      query.set("include_users", "true");
      if (typeof input?.team_id === "string") query.set("team_id", input.team_id);
    }
    const url = `https://slack.com/api/${method}${query ? `?${query.toString()}` : ""}`;
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(query ? {} : { "content-type": "application/json; charset=utf-8" }),
      },
      method: query ? "GET" : "POST",
      ...(query ? {} : { body: JSON.stringify(input ?? {}) }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let result: Record<string, unknown>;
    try {
      result = record(await response.json(), `Slack ${method} response`);
    } catch (cause) {
      if (cause instanceof SlackUserGroupApiError) throw cause;
      throw new SlackUserGroupApiError(method, response.status, "invalid_response");
    }
    if (!response.ok || result.ok !== true) {
      throw new SlackUserGroupApiError(
        method,
        response.status,
        optionalText(result.error) ?? `http_${String(response.status)}`,
      );
    }
    return result;
  }

  return {
    async create(value) {
      const result = await request("usergroups.create", desiredBody(desiredState(value)));
      return normalizedUserGroup(result.usergroup);
    },
    async disable(id, teamId) {
      const result = await request("usergroups.disable", lifecycleBody(id, teamId));
      return normalizedUserGroup(result.usergroup);
    },
    async enable(id, teamId) {
      const result = await request("usergroups.enable", lifecycleBody(id, teamId));
      return normalizedUserGroup(result.usergroup);
    },
    async list(teamId) {
      const result = await request("usergroups.list", teamId ? { team_id: teamId } : undefined);
      if (!Array.isArray(result.usergroups)) {
        throw new SlackUserGroupApiError("usergroups.list", 200, "invalid_response");
      }
      return result.usergroups.map((value) => normalizedUserGroup(value, true));
    },
    async update(id, value) {
      const desired = desiredState(value);
      const result = await request("usergroups.update", {
        ...desiredBody(desired, true),
        usergroup: userGroupId(id),
      });
      return normalizedUserGroup(result.usergroup);
    },
  };
}

function differs(current: SlackUserGroup, desired: ReturnType<typeof desiredState>) {
  return (
    current.description !== desired.description ||
    current.handle !== desired.handle ||
    current.name !== desired.name
  );
}

export async function reconcileSlackUserGroup(input: {
  readonly client: SlackUserGroupClient;
  readonly desired: SlackUserGroupDesiredState;
  readonly userGroupId: string;
}) {
  const desired = desiredState(input.desired);
  const actions: SlackUserGroupAction[] = [];
  const id = userGroupId(input.userGroupId);
  const existing = await input.client.list(desired.teamId);
  const matched = existing.find((candidate) => candidate.id === id);
  if (!matched) throw new Error(`Pinned Slack user group ${id} was not found.`);
  let current = matched;

  if (differs(current, desired)) {
    current = await input.client.update(current.id, desired);
    actions.push("updated");
  }
  if (desired.status === "active" && current.status === "disabled") {
    current = await input.client.enable(current.id, desired.teamId);
    actions.push("enabled");
  }
  if (desired.status === "disabled" && current.status === "active") {
    current = await input.client.disable(current.id, desired.teamId);
    actions.push("disabled");
  }
  if (current.status !== desired.status || differs(current, desired)) {
    throw new Error(`Slack user group ${current.id} did not converge to the desired state.`);
  }
  return { actions, userGroup: current } as const;
}
