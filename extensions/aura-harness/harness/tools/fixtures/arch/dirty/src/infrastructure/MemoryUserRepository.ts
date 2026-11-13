import type { User } from '../domain/User';

export class MemoryUserRepository {
  private readonly users = new Map<string, User>();

  find(id: string): User | null {
    return this.users.get(id) ?? null;
  }

  save(user: User): void {
    this.users.set(user.id, user);
  }
}
