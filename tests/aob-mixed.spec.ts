import { test } from '@playwright/test';
import { deployAndCompleteAob } from '../src/aobFormsWorkflow';
import { runSearchForCompletedAob, runSearchScenario } from '../src/searchWorkflow';
import type { VuContext } from '../src/aobTypes';
import { forceFormPath, runWithMetrics } from './aobTestHelpers';
import { TestEvents } from './testEvents';

test.describe('AOB mixed workflow', () => {
  test('submits an AOB form to the database and finds the same form in search', async ({ page }, testInfo) => {
    forceFormPath('download');
    const events = new TestEvents();
    const vuContext: VuContext = {};

    await runWithMetrics(testInfo, 'aob-submit-and-search-same-form-metrics', events, async () => {
      const completedForm = await deployAndCompleteAob(page, vuContext, events);
      await runSearchForCompletedAob(completedForm, events);
    });
  });

  test('runs the seeded mixed search workflow after a form download submit', async ({ page }, testInfo) => {
    forceFormPath('download');
    const events = new TestEvents();
    const vuContext: VuContext = {};

    await runWithMetrics(testInfo, 'aob-mixed-workflow-metrics', events, async () => {
      await deployAndCompleteAob(page, vuContext, events);
      await runSearchScenario(page, vuContext, events);
    });
  });
});
