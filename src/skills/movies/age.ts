import type { User } from './types.js';

export function computeCurrentAge(user: User): number | null {
  if (user.birth_date) {
    const birth = new Date(user.birth_date);
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const m = now.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
    return age;
  }
  if (user.age_static !== null) {
    if (!user.age_recorded_at) return user.age_static;
    return user.age_static + (new Date().getFullYear() - new Date(user.age_recorded_at).getFullYear());
  }
  return null;
}
