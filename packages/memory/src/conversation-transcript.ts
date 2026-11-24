export interface MemoryConversationMessage {
  readonly content: string;
  readonly createdAt?: string;
  readonly role: string;
}

export function conversationMessagePrefix(message: {
  readonly createdAt?: string;
  readonly role: string;
}): string {
  if (!message.createdAt) return `${message.role}: `;
  const timestamp = Date.parse(message.createdAt);
  const canonical = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
  return `${canonical ? `[${canonical}] ` : ""}${message.role}: `;
}
