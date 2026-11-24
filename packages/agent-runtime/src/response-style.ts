const RECENT_ASSISTANT_BUBBLES = 8;
const HABITUAL_LAUGHTER_THRESHOLD = 3;
const ASSISTANT_BUBBLE = /\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/gu;
const QUOTED_OR_CODE_LITERAL =
  /(`+)[\s\S]*?\1|(~{3,})[\s\S]*?\2|"[^"]*"|“[^”]*”|(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])|‘[^’]*’/gu;
// Quotes and backticks are deliberately absent: a literal such as `lol` or "lol!"
// is not a bare conversational ending, even when punctuation follows the literal.
const BARE_LAUGHTER_ENDING =
  /(?:^|[\s,;:!?()[\]{}—–-])(?:lol|lmao|lmfao|rofl|(?:ha){2,}h?|(?:he){2,}h?)[.!?,;:…()[\]{}]*\s*$/iu;

function hasBareLaughterEnding(bubble: RegExpMatchArray, message: string): boolean {
  const text = bubble[0];
  const ending = BARE_LAUGHTER_ENDING.exec(text);
  if (!ending) return false;
  const trimmed = text.trimEnd();
  const finalLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  if (/^\s*>/u.test(finalLine)) return false;

  // A blank line inside a multiline literal must not turn its contents into a
  // conversational suffix. Check spans in the original message without rewriting it.
  const tokenIndex = bubble.index! + ending.index + ending[0].search(/\w/u);
  for (const literal of message.matchAll(QUOTED_OR_CODE_LITERAL)) {
    if (literal.index > tokenIndex) break;
    if (literal.index + literal[0].length > tokenIndex) return false;
  }
  return true;
}

export function hasHabitualLaughterEnding(reply: string, history: readonly string[]): boolean {
  let candidateHasLaughterEnding = false;
  for (const bubble of reply.matchAll(ASSISTANT_BUBBLE)) {
    if (!hasBareLaughterEnding(bubble, reply)) continue;
    candidateHasLaughterEnding = true;
    break;
  }
  if (!candidateHasLaughterEnding) return false;

  let recentBubbles = 0;
  let laughterEndings = 0;
  for (let messageIndex = history.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = history[messageIndex]!;
    const bubbles = [...message.matchAll(ASSISTANT_BUBBLE)];
    for (let bubbleIndex = bubbles.length - 1; bubbleIndex >= 0; bubbleIndex -= 1) {
      const bubble = bubbles[bubbleIndex]!;
      recentBubbles += 1;
      if (hasBareLaughterEnding(bubble, message)) laughterEndings += 1;
      if (laughterEndings >= HABITUAL_LAUGHTER_THRESHOLD) return true;
      if (recentBubbles >= RECENT_ASSISTANT_BUBBLES) return false;
    }
  }
  return false;
}
