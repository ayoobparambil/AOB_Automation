import { test } from '@playwright/test';
import { deployAndCompleteAob } from '../src/aobFormsWorkflow';
import type { VuContext } from '../src/aobTypes';
import { forceFormPath, runWithMetrics } from './aobTestHelpers';
import { TestEvents } from './testEvents';

test.describe('AOB form browser workflow', () => {
  test('deploys an AOB form and completes the approve path without download', async ({ page }, testInfo) => {
    forceFormPath('no_download');
    const events = new TestEvents();
    const vuContext: VuContext = {};

    await runWithMetrics(testInfo, 'aob-approve-no-download-metrics', events, async () => {
      await deployAndCompleteAob(page, vuContext, events);
    });
  });

  test('deploys an AOB form, approves it, and opens the download document', async ({ page }, testInfo) => {
    forceFormPath('download');
    const events = new TestEvents();
    const vuContext: VuContext = {};

    await runWithMetrics(testInfo, 'aob-approve-download-metrics', events, async () => {
      await deployAndCompleteAob(page, vuContext, events);
    });
  });

  test('deploys an AOB form and completes the decline path', async ({ page }, testInfo) => {
    forceFormPath('decline');
    const events = new TestEvents();
    const vuContext: VuContext = {};

    await runWithMetrics(testInfo, 'aob-decline-metrics', events, async () => {
      await deployAndCompleteAob(page, vuContext, events);
    });
  });
});
