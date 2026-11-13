import type { User } from './User';

// Commented-out imports must not count as dependencies:
// import { renderRegistration } from '../ui/App';

export interface UserRepository {
  find(id: string): User | null;
  save(user: User): void;
}
