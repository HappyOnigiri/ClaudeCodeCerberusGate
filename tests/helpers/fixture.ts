// Test doubles deliberately implement only the exercised portion of a host contract.
// Keep the unchecked conversion at the fixture boundary, with runtime assertions in tests.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- callers explicitly name the exercised fixture contract at the unchecked test boundary
export function asFixture<T>(value: unknown): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- partial host mocks and adversarial inputs intentionally do not satisfy the complete SDK contract
  return value as T;
}
