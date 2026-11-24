import { expect, test } from "bun:test";
import { join } from "node:path";
import { AgentPlatformSkillName, MAX_AGENT_SKILL_CHARACTERS } from "@deployments-ai/agent-manifest";
import { PLATFORM_SKILLS } from "./platform-skills.ts";

test("every bundled skill is a platform skill a manifest can name, without its frontmatter", () => {
  const skillsDirectory = join(import.meta.dir, "../skills");
  const sorted = (names: readonly (string | undefined)[]) =>
    names.toSorted((left = "", right = "") => left.localeCompare(right));
  const bundled = sorted(
    Array.from(new Bun.Glob("*/SKILL.md").scanSync(skillsDirectory)).map(
      (file) => file.split("/")[0],
    ),
  );
  expect(bundled).toEqual(sorted(AgentPlatformSkillName.literals));
  expect(sorted(Object.keys(PLATFORM_SKILLS))).toEqual(bundled);
  for (const [name, body] of Object.entries(PLATFORM_SKILLS)) {
    expect(body.startsWith("# "), name).toBe(true);
    expect(body).not.toContain("\ndescription: ");
    expect(body.length, name).toBeLessThanOrEqual(MAX_AGENT_SKILL_CHARACTERS);
  }
});
