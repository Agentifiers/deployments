import { describe, expect, it } from "bun:test";
import { hasHabitualLaughterEnding } from "./response-style.ts";

describe("habitual laughter endings", () => {
  it("requires three recent laughter-ending bubbles before rejecting a new ending", () => {
    const history = Object.freeze(["That was close lol\n\nYou caught me lol"]);

    expect(hasHabitualLaughterEnding("Not again lol", [])).toBe(false);
    expect(hasHabitualLaughterEnding("Not again lol", history)).toBe(false);
    expect(hasHabitualLaughterEnding("Not again lol", [...history, "Fair point lol"])).toBe(true);
    expect(hasHabitualLaughterEnding("  \n\n", [...history, "Fair point lol"])).toBe(false);
  });

  it("counts mixed laughter spellings as one habit and checks every candidate bubble", () => {
    const history = ["That figures LOL!  \r\n \r\nExactly lMfAo…", "Caught me HeHeH?!"];

    expect(
      hasHabitualLaughterEnding("Fair enough\n\nNot again ROFL.\n\nAnyway, tell me more", history),
    ).toBe(true);
    expect(hasHabitualLaughterEnding("You got me hahaha!", history)).toBe(true);
    expect(hasHabitualLaughterEnding("That's funny lmao", history)).toBe(true);
    expect(hasHabitualLaughterEnding("I said lol earlier, but here's my answer.", history)).toBe(
      false,
    );
  });

  it("ages laughter out after eight bubbles rather than eight model turns", () => {
    const laughter = "First lol\n\nSecond lmao\n\nThird haha";
    const later = "One\n\nTwo\n\nThree\n\nFour\n\nFive";

    expect(hasHabitualLaughterEnding("Again lol", [laughter, later])).toBe(true);
    expect(hasHabitualLaughterEnding("Again lol", [laughter, `${later}\n\nSix`])).toBe(false);
    expect(hasHabitualLaughterEnding("Again lol", [laughter, `${later}\n\nSix`, " \n\n "])).toBe(
      false,
    );
  });

  it("preserves quoted and code literals and does not generalize to meaningful repeated endings", () => {
    const history = ["First lol", "Second lmao", "Third hehe"];
    const literalReply = 'The token is "lol!".\n\nOr ‘lmao’.\n\nUse `rofl`.\n\n> haha';
    const fencedLiteral = "```text\nlol\n\nlmao\n\nhehe\n\n```";

    expect(hasHabitualLaughterEnding(literalReply, history)).toBe(false);
    expect(hasHabitualLaughterEnding(fencedLiteral, history)).toBe(false);
    expect(hasHabitualLaughterEnding('She wrote "first lol\n\nthen lmao".', history)).toBe(false);
    expect(hasHabitualLaughterEnding("Again lol", [literalReply, fencedLiteral])).toBe(false);
    expect(
      hasHabitualLaughterEnding("Again lol", [
        "Thanks, love",
        "Of course, love",
        "Goodnight, love",
      ]),
    ).toBe(false);
    expect(hasHabitualLaughterEnding("Goodnight, love", history)).toBe(false);
    expect(hasHabitualLaughterEnding('She said "hello", and I waved lol', history)).toBe(true);
    expect(hasHabitualLaughterEnding(`${fencedLiteral}\n\nThat's the example lol`, history)).toBe(
      true,
    );
  });
});
