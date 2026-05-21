import type { TestInfo } from '@playwright/test';
import { attachMetrics, TestEvents } from './testEvents';

export function forceFormPath(path: 'download' | 'no_download' | 'decline'): void {
  process.env.AOB_FORM_DOWNLOAD_WEIGHT = path === 'download' ? '1' : '0';
  process.env.AOB_FORM_NO_DOWNLOAD_WEIGHT = path === 'no_download' ? '1' : '0';
  process.env.AOB_FORM_DECLINE_WEIGHT = path === 'decline' ? '1' : '0';
}

export async function runWithMetrics(
  testInfo: TestInfo,
  name: string,
  events: TestEvents,
  action: () => Promise<void>
): Promise<void> {
  try {
    await action();
  } finally {
    await attachMetrics(testInfo.attach.bind(testInfo), name, events);
  }
}
