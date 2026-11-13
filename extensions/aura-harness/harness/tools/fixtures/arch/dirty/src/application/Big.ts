export function processEverything(a: string, b: string, c: string, d: string, e: string, f: string): string {
  let result = '';
  for (let i = 0; i < 3; i += 1) {
    if (i === 0) {
      if (a) {
        if (b) {
          result += a;
        }
      }
    }
    result += b;
    result += c;
    result += d;
    result += e;
    result += f;
    result += a;
    result += b;
    result += c;
    result += d;
    result += e;
    result += f;
    result += a;
    result += b;
    result += c;
    result += d;
    result += e;
    result += f;
    result += a;
    result += b;
    result += c;
    result += d;
    result += e;
    result += f;
    result += a;
    result += b;
    result += c;
    result += d;
    result += e;
    result += f;
    result += a;
    result += b;
    result += c;
    result += d;
    result += e;
    result += f;
  }
  return result;
}
