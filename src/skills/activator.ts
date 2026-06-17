import type { Skill } from './types.js';
import { getAllSkills } from './registry.js';
import { getSessionActiveSkills, setSessionActiveSkills } from '../memory/sqlite.js';

const MAX_ACTIVE_SKILLS = 3;

// In-memory cache: sessionId -> active skill names. Write-through to DB.
const activeSkillsBySession = new Map<string, string[]>();

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s.,!?;:'"()\[\]{}<>\/\\—–-]+/).filter(Boolean);
}

function matchesSkill(skill: Skill, message: string): boolean {
  const msgTokens = tokenize(message);
  return skill.examples.some((example) => {
    const exTokens = tokenize(example);
    if (exTokens.length === 0) return false;
    return msgTokens.some((_, i) => exTokens.every((et, j) => msgTokens[i + j] === et));
  });
}

function loadFromDb(sessionId: string): string[] {
  try { return getSessionActiveSkills(sessionId); } catch { return []; }
}

function saveToDb(sessionId: string, skills: string[]): void {
  try { setSessionActiveSkills(sessionId, skills); } catch { /* DB not available in tests */ }
}

// Sticky + additive: a newly-relevant skill is added to the live set, never swapped in.
// Capped at MAX_ACTIVE_SKILLS, evicting the least-recently-activated skill when over cap.
// Active set is persisted to DB so it survives container restarts.
export function activateSkills(sessionId: string, message: string): Skill[] {
  const all = getAllSkills();

  // Populate cache from DB on first access for this session in this process
  if (!activeSkillsBySession.has(sessionId)) {
    activeSkillsBySession.set(sessionId, loadFromDb(sessionId));
  }
  let active = activeSkillsBySession.get(sessionId)!;

  let changed = false;
  for (const skill of all) {
    if (!active.includes(skill.name) && matchesSkill(skill, message)) {
      active = [...active, skill.name];
      changed = true;
    }
  }
  if (active.length > MAX_ACTIVE_SKILLS) {
    active = active.slice(active.length - MAX_ACTIVE_SKILLS);
    changed = true;
  }

  activeSkillsBySession.set(sessionId, active);
  if (changed) saveToDb(sessionId, active);

  const byName = new Map(all.map((skill) => [skill.name, skill]));
  return active.map((name) => byName.get(name)).filter((skill): skill is Skill => skill !== undefined);
}

export function _resetActivatorForTests(): void {
  activeSkillsBySession.clear();
}
