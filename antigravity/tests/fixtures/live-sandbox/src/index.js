/**
 * Sandbox Demo Service for Live Verification
 */
export function calculateFibonacci(n) {
  if (n <= 1) return n;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return b;
}

export function greet(name = "World") {
  return `Hello, ${name}! Welcome to EverOS Antigravity Sandbox.`;
}
