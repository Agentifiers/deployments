import { SESv2Client } from "@aws-sdk/client-sesv2";

const clients = new Map<string, SESv2Client>();

export function sesClient(region: string) {
  const existing = clients.get(region);
  if (existing) return existing;
  const created = new SESv2Client({ region });
  clients.set(region, created);
  return created;
}

export function alreadyExists(cause: unknown) {
  return cause instanceof Error && cause.name === "AlreadyExistsException";
}

export function notFound(cause: unknown) {
  return cause instanceof Error && cause.name === "NotFoundException";
}
