import type { Skill } from './types.js';
import { getAllSkills } from './registry.js';

const MAX_ACTIVE_SKILLS = 3;

// sessionId -> active skill names, least-recently-activated first
const activeSkillsBySession = new Map<string, string[]>();

function matchesSkill(skill: Skill, message: string): boolean {
  const lower = message.toLowerCase();
  return skill.examples.some((example) => lower.includes(example.toLowerCase()));
}

// Sticky + additive: a newly-relevant skill is added to the live set, never swapped in.
// Capped at MAX_ACTIVE_SKILLS, evicting the least-recently-activated skill when over cap.
export function activateSkills(sessionId: string, message: string): Skill[] {
  const all = getAllSkills();
  let active = activeSkillsBySession.get(sessionId) ?? [];

  for (const skill of all) {
    if (!active.includes(skill.name) && matchesSkill(skill, message)) {
      active = [...active, skill.name];
    }
  }
  if (active.length > MAX_ACTIVE_SKILLS) {
    active = active.slice(active.length - MAX_ACTIVE_SKILLS);
  }
  activeSkillsBySession.set(sessionId, active);

  const byName = new Map(all.map((skill) => [skill.name, skill]));
  return active.map((name) => byName.get(name)).filter((skill): skill is Skill => skill !== undefined);
}

export function _resetActivatorForTests(): void {
  activeSkillsBySession.clear();
}
