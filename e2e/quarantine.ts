import type { TestInfo, TestType } from '@playwright/test';

// Remove the annotation after the cause is fixed and the isolated case is stable.
export const QUARANTINE: Record<string, { file: string; cause: string; deadline: string }> = {};

export function quarantine<T extends {}, W extends {}>(test: TestType<T, W>, id: keyof typeof QUARANTINE, title: string, body: (args: T & W, info: TestInfo) => Promise<void>) {
  const item = QUARANTINE[id];
  if (!item) throw new Error(`Unknown quarantined browser case: ${id}`);
  test.describe(() => {
    test.describe.configure({ retries: 1 });
    test(title, { tag: '@quarantined', annotation: { type: 'quarantine', description: `${id}; fix by ${item.deadline}; ${item.cause}` } }, body);
  });
}
