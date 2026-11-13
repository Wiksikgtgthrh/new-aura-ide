export type User = { id: string; name: string };

export function createUser(id: string, name: string): User {
  return { id, name };
}
