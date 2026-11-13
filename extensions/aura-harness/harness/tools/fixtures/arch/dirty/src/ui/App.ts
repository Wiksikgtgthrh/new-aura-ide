import type { User } from '../domain/User';

export function renderRegistration(user: User | null): string {
  return user ? `user: ${user.name}` : 'nobody';
}
