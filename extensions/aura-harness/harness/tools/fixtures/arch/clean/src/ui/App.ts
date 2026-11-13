import { registerUser } from '../application/RegisterUser';
import type { UserRepository } from '../domain/UserRepository';

export function renderRegistration(repo: UserRepository): string {
  const user = registerUser(repo, 'u-1', 'Ada');
  return `user: ${user.name}`;
}
