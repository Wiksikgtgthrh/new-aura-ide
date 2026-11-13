import { stepB } from './B';

export function stepA(value: number): number {
  return value === 0 ? 0 : stepB(value - 1) + 1;
}
