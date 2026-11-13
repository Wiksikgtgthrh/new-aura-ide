import type { User } from '../domain/User';
import type { UserRepository } from '../domain/UserRepository';

export class MemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, User>();

  find(id: string): User | null {
    return this.users.get(id) ?? null;
  }

  save(user: User): void {
    this.users.set(user.id, user);
  }
}
