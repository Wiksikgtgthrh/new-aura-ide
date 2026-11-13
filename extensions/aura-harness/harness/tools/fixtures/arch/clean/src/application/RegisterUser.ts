import { createUser, type User } from '../domain/User';
import type { UserRepository } from '../domain/UserRepository';

export function registerUser(repo: UserRepository, id: string, name: string): User {
  const existing = repo.find(id);
  if (existing) return existing;
  const user = createUser(id, name);
  repo.save(user);
  return user;
}
