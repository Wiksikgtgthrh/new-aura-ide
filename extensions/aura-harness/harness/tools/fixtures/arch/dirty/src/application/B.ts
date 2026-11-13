import { stepA } from './A';

export function stepB(value: number): number {
  return value === 0 ? 0 : stepA(value - 1) + 1;
}
