import { MemoryUserRepository } from '../infrastructure/MemoryUserRepository';

export function panel(): string {
  const repo = new MemoryUserRepository();
  return repo.find('u-1')?.name ?? 'nobody';
}
