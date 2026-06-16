import type { Skill } from './types.js';

const skills = new Map<string, Skill>();

export function registerSkill(skill: Skill): void {
  skill.migrate();
  skills.set(skill.name, skill);
}

export function getAllSkills(): Skill[] {
  return [...skills.values()];
}

export function _resetRegistryForTests(): void {
  skills.clear();
}
