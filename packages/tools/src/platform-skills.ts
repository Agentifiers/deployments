import type { AgentPlatformSkillName } from "@deployments-ai/agent-manifest";
import appBuilder from "../skills/app-builder/SKILL.md" with { type: "text" };
import appPublication from "../skills/app-publication/SKILL.md" with { type: "text" };
import computerUse from "../skills/computer-use/SKILL.md" with { type: "text" };

/** Drops the YAML frontmatter, which names and describes the skill for catalogs, not for the model. */
function skillBody(skill: string): string {
  return skill.replace(/^---\n[\s\S]*?\n---\n/u, "").trim();
}

/** The skills bundled in packages/tools/skills, by the name a manifest pins them with in `spec.platformSkills`. */
export const PLATFORM_SKILLS: Readonly<Record<AgentPlatformSkillName, string>> = {
  "app-builder": skillBody(appBuilder),
  "app-publication": skillBody(appPublication),
  "computer-use": skillBody(computerUse),
};
