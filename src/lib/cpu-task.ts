// Deliberately naive (exponential time, O(2^n)) — the cost itself is what's under study.
export function fibonacci(n: number): number {
  if (n < 2) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
