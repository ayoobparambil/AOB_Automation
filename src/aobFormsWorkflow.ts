import { request as playwrightRequest, type Locator, type Page } from '@playwright/test';
import {
  humanPause,
  parsePayloadJson,
  fillSixDigitCode,
  randomIncorrectAccessCode,
  pickWeighted,
  performSuccessfulLogin,
  dobToAccessCode
} from './aobHelpers';
import { nextRowFromPool } from './testData';
import type {
  DeployCsvRow,
  DeployPayload,
  AobCompletionResult,
  DobValidationPath,
  FormCompletionPath,
  VuContext,
  Events,
} from './aobTypes';

const DOB_VALIDATION_WEIGHTS: Record<DobValidationPath, number> = {
  first_attempt: 60,
  second_attempt: 30,
  third_attempt: 10,
};

function getEnvWeight(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number(rawValue);

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative number.`);
  }

  return parsedValue;
}

function getFormCompletionWeights(): Record<FormCompletionPath, number> {
  const weights: Record<FormCompletionPath, number> = {
    download: getEnvWeight('AOB_FORM_DOWNLOAD_WEIGHT', 50),
    no_download: getEnvWeight('AOB_FORM_NO_DOWNLOAD_WEIGHT', 30),
    decline: getEnvWeight('AOB_FORM_DECLINE_WEIGHT', 20),
  };

  if (Object.values(weights).every((weight) => weight === 0)) {
    throw new Error('At least one AOB form completion weight must be greater than zero.');
  }

  return weights;
}

const FORM_NAVIGATION_MAX_ATTEMPTS = 3;
const FORM_NAVIGATION_TIMEOUT_MS = 90000;
const FORM_NAVIGATION_BACKOFF_MS = [2000, 5000];

function resolveDeployRow(vuContext: VuContext): DeployCsvRow {
  const existingPayloadJson = String(vuContext?.vars?.payloadJson ?? '').trim();

  if (existingPayloadJson) {
    return vuContext.vars as unknown as DeployCsvRow;
  }

  return nextRowFromPool<DeployCsvRow>('deploy', 'deploy.csv');
}

async function collectPageDebugContext(page: Page): Promise<string> {
  const currentUrl = page.url();
  const title = await page.title().catch(() => 'unavailable');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const normalizedBody = bodyText.replace(/\s+/g, ' ').trim();
  const snippet = normalizedBody.slice(0, 300);

  return `Url=${currentUrl}, Title=${title}, BodySnippet=${snippet || 'n/a'}`;
}

async function expectVisibleWithDebug(
  locator: ReturnType<Page['locator']>,
  page: Page,
  label: string,
  timeout = 60000
): Promise<void> {
  try {
    await locator.waitFor({ state: 'visible', timeout });
  } catch (error) {
    const debugContext = await collectPageDebugContext(page);
    throw new Error(`${label} was not visible. ${debugContext}. Cause=${String(error)}`);
  }
}

async function expectEnabledWithDebug(
  locator: Locator,
  page: Page,
  label: string,
  timeout = 10000
): Promise<void> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) {
      return;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(`${label} was not enabled. ${await collectPageDebugContext(page)}`);
}

async function isGatewayErrorPage(page: Page): Promise<boolean> {
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const text = `${title} ${bodyText}`;

  return /502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout|Application Gateway/i.test(text);
}

function isInterruptedRedirect(error: unknown): boolean {
  return /Navigation to ".*" is interrupted by another navigation to/i.test(String(error));
}

async function hasReachedFormsPage(page: Page): Promise<boolean> {
  const currentUrl = page.url();

  if (!/^https:\/\/forms\./i.test(currentUrl)) {
    return false;
  }

  return !await isGatewayErrorPage(page);
}

async function gotoFormWithRetry(page: Page, formUrl: string, events: Events): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= FORM_NAVIGATION_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await page.goto(formUrl, {
        waitUntil: 'domcontentloaded',
        timeout: FORM_NAVIGATION_TIMEOUT_MS,
      });

      const status = response?.status();
      const transientServerStatus = status !== undefined && status >= 500 && status < 600;

      if (transientServerStatus || await isGatewayErrorPage(page)) {
        throw new Error(`Form navigation reached transient server error page. Status=${status ?? 'unknown'}`);
      }

      return;
    } catch (error) {
      lastError = error;

      if (isInterruptedRedirect(error) && await hasReachedFormsPage(page)) {
        events.emit('counter', 'aob.form_navigation.redirect_interrupted_but_recovered', 1);
        return;
      }

      events.emit('counter', `aob.form_navigation.attempt_failed.${attempt}`, 1);

      if (attempt === FORM_NAVIGATION_MAX_ATTEMPTS) {
        const debugContext = await collectPageDebugContext(page);
        throw new Error(
          `Form navigation failed after ${FORM_NAVIGATION_MAX_ATTEMPTS} attempts. ${debugContext}. Cause=${String(lastError)}`
        );
      }

      await page.waitForTimeout(FORM_NAVIGATION_BACKOFF_MS[attempt - 1] ?? 5000);
    }
  }
}

function questionBlock(page: Page, questionText: RegExp, optionText: RegExp) {
  return page
    .locator('fieldset, [role="group"], section, div')
    .filter({ has: page.getByText(questionText) })
    .filter({ has: page.getByText(optionText) })
    .last();
}

function consentBlock(page: Page) {
  const legacyConsent = questionBlock(
    page,
    /Do you consent to assign the medicare benefit\?/i,
    /^(Approve|Decline)$/
  );

  const currentBulkBillConsent = page
    .locator('body')
    .filter({ hasText: /Bulk Bill Assignment of Benefit Agreement/i })
    .filter({ has: page.getByText(/^Approve$/) })
    .filter({ has: page.getByText(/^Decline$/) });

  return legacyConsent.or(currentBulkBillConsent).first();
}

async function clickConsentOption(page: Page, consent: Locator, option: 'Approve' | 'Decline'): Promise<void> {
  const optionName = new RegExp(`^${option}$`, 'i');
  const optionTextPrefix = new RegExp(`^${option}\\b`, 'i');
  const radioOption = consent.getByRole('radio', { name: optionName }).first();

  if (await radioOption.isVisible().catch(() => false)) {
    await radioOption.click();
    return;
  }

  const buttonOption = consent.getByRole('button', { name: optionName }).first();

  if (await buttonOption.isVisible().catch(() => false)) {
    await buttonOption.click();
    return;
  }

  const labelOption = consent.getByLabel(optionName).first();

  if (await labelOption.isVisible().catch(() => false)) {
    await labelOption.click();
    return;
  }

  const textOptions = consent.getByText(optionTextPrefix);
  const textOptionCount = await textOptions.count();

  for (let i = textOptionCount - 1; i >= 0; i--) {
    const textOption = textOptions.nth(i);

    if (!await textOption.isVisible().catch(() => false)) {
      continue;
    }

    await textOption.click({ force: true }).catch(async () => {
      await textOption.evaluate((element) => {
      const clickable = element.closest<HTMLElement>(
        'button, label, [role="button"], [role="radio"], [tabindex], [class*="choice"], [class*="Choice"], [class*="option"], [class*="Option"], [class*="radio"], [class*="Radio"]'
      );

      (clickable ?? element as HTMLElement).click();
      });
    });
    return;
  }

  throw new Error(`Unable to find selectable ${option} consent control. ${await collectPageDebugContext(page)}`);
}

async function clickComplete(page: Page): Promise<void> {
  const completeButton = page.getByRole('button', { name: /complete/i }).first();

  await expectVisibleWithDebug(completeButton, page, 'Complete button');
  await expectEnabledWithDebug(completeButton, page, 'Complete button');
  await completeButton.click();
}

async function verifyDownloadedDocumentPatient(
  sourcePage: Page,
  downloadPage: Page,
  payload: DeployPayload,
  events: Events
): Promise<void> {
  const patientName = String(payload.patient?.name ?? '').trim();
  const patientDob = String(payload.patient?.dob ?? '').trim();

  if (!patientName || !patientDob) {
    throw new Error(
      `Cannot verify downloaded document patient because payload patient details are incomplete. PatientName=${patientName || 'empty'}, PatientDob=${patientDob || 'empty'}`
    );
  }

  try {
    await downloadPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
    await downloadPage.getByText(patientName, { exact: false }).first().waitFor({ state: 'visible', timeout: 30000 });
    await downloadPage.getByText(patientDob, { exact: false }).first().waitFor({ state: 'visible', timeout: 30000 });

    events.emit('counter', 'aob.download.patient_match.success', 1);
  } catch (error) {
    const downloadDebugContext = await collectPageDebugContext(downloadPage);

    try {
      await sourcePage.getByText(patientName, { exact: false }).first().waitFor({ state: 'visible', timeout: 10000 });
      await sourcePage.getByText(patientDob, { exact: false }).first().waitFor({ state: 'visible', timeout: 10000 });

      events.emit('counter', 'aob.download.patient_match.source_summary_success', 1);
      return;
    } catch (sourceError) {
      const sourceDebugContext = await collectPageDebugContext(sourcePage);

      events.emit('counter', 'aob.download.patient_match.failed', 1);
      throw new Error(
        `Downloaded document and submitted agreement summary did not show the expected patient details. ExpectedPatientName=${patientName}, ExpectedPatientDob=${patientDob}. DownloadPage=${downloadDebugContext}. SourcePage=${sourceDebugContext}. DownloadCause=${String(error)}. SourceCause=${String(sourceError)}`
      );
    }
  }
}

export async function deployAndCompleteAob(
  page: Page,
  vuContext: VuContext,
  events: Events
): Promise<AobCompletionResult> {
  const deployEndpoint =
    'https://stage.bponline.dev/api/pracsvcs/forms/templates/aob/$deploy';

  const deployRow = resolveDeployRow(vuContext);
  const tenantId = String(deployRow.TenantId ?? '').trim();
  const bearerToken = String(deployRow.APIKey ?? '').trim();
  const rawPayloadJson = String(deployRow.payloadJson ?? '').trim();

  if (!tenantId) {
    throw new Error('Missing TenantId from deploy.csv row.');
  }

  if (!bearerToken) {
    throw new Error(`Missing APIKey from deploy.csv row for tenant ${tenantId}.`);
  }

  if (!rawPayloadJson) {
    throw new Error(`Missing payloadJson from deploy.csv row for tenant ${tenantId}.`);
  }

  const payload = parsePayloadJson<DeployPayload>(rawPayloadJson);

  const dobValidationPath = pickWeighted(DOB_VALIDATION_WEIGHTS);
  const formCompletionPath = pickWeighted(getFormCompletionWeights());

  events.emit('counter', `aob.dob_validation_path.${dobValidationPath}`, 1);
  events.emit('counter', `aob.form_completion_path.${formCompletionPath}`, 1);

  const apiContext = await playwrightRequest.newContext({
    extraHTTPHeaders: {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  try {
    const deployStart = Date.now();

    const deployResponse = await apiContext.post(deployEndpoint, {
      data: payload,
    });

    const deployDurationMs = Date.now() - deployStart;
    events.emit('histogram', 'aob.deploy.duration', deployDurationMs);

    const status = deployResponse.status();
    const responseText = await deployResponse.text();

    events.emit('counter', `aob.deploy.status.${status}`, 1);

    if (status < 200 || status >= 300) {
      events.emit('counter', 'aob.deploy.failed', 1);
      throw new Error(
        `Deploy failed. Tenant=${tenantId}, Reference=${payload.reference}, Status=${status}, Body=${responseText}`
      );
    }

    const deployJson = JSON.parse(responseText);
    const formUrl = deployJson.url as string;
    const formId = String(deployJson.id ?? deployJson.formId ?? '').trim();
    const formOrigin = new URL(formUrl).origin;

    if (!formUrl) {
      throw new Error(`Deploy response did not contain a form URL. Tenant=${tenantId}, Reference=${payload.reference}`);
    }

    await gotoFormWithRetry(page, formUrl, events);

    await humanPause(page, 2000, 5000);

    await expectVisibleWithDebug(page.getByRole('textbox').first(), page, 'DOB identity input');

    const patientDob = String(payload.patient?.dob ?? '').trim();
    const correctAccessCode = dobToAccessCode(patientDob);

    if (!/^\d{6}$/.test(correctAccessCode)) {
      throw new Error(
        `Deploy payload has invalid patient DOB. Tenant=${tenantId}, Reference=${payload.reference}, patientDob=${patientDob || 'empty'}`
      );
    }

    if (dobValidationPath === 'first_attempt') {

      await performSuccessfulLogin(page, events, correctAccessCode);

    } else if (dobValidationPath === 'second_attempt') {
      const wrongCode = randomIncorrectAccessCode(correctAccessCode);

      await fillSixDigitCode(page, wrongCode);
      await humanPause(page, 500, 1200);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expectVisibleWithDebug(page.getByRole('textbox').first(), page, 'DOB identity input after second-attempt retry');

      await humanPause(page, 2000, 3000);
      await performSuccessfulLogin(page, events, correctAccessCode);

    } else if (dobValidationPath === 'third_attempt') {
      const wrongCode1 = randomIncorrectAccessCode(correctAccessCode);
      const wrongCode2 = randomIncorrectAccessCode(correctAccessCode);

      await fillSixDigitCode(page, wrongCode1);
      await humanPause(page, 500, 1200);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expectVisibleWithDebug(page.getByRole('textbox').first(), page, 'DOB identity input after third-attempt retry 1');

      await humanPause(page, 2000, 2500);

      await fillSixDigitCode(page, wrongCode2);
      await humanPause(page, 500, 1200);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expectVisibleWithDebug(page.getByRole('textbox').first(), page, 'DOB identity input after third-attempt retry 2');

      await humanPause(page, 2000, 2500);
      await performSuccessfulLogin(page, events, correctAccessCode);
    }

    await humanPause(page, 800, 1800);

    const q1 = questionBlock(page, /Is the assignor the patient\?/i, /^Yes$/);

    if (await q1.isVisible().catch(() => false)) {
      await humanPause(page, 1000, 2000);
      await q1.getByText(/^Yes$/).first().click();
      await humanPause(page, 800, 1800);
    } else {
      events.emit('counter', 'aob.assignor_question.skipped', 1);
    }

    const q2 = consentBlock(page);
    await expectVisibleWithDebug(q2, page, 'Consent question');

    await humanPause(page, 1000, 2000);

    if (formCompletionPath === 'decline') {
      await clickConsentOption(page, q2, 'Decline');

      const declineStart = performance.now();

      await clickComplete(page);

      await expectVisibleWithDebug(
        page.getByText('You have Declined the consent to assign the Medicare benefit.')
      , page, 'Decline confirmation message');

      const declineDurationMs = performance.now() - declineStart;
      events.emit('histogram', 'aob.decline_submit_to_message.duration', declineDurationMs);
      events.emit('counter', 'aob.decline_submit_to_message.success', 1);

      return {
        tenantId,
        apiKey: bearerToken,
        reference: payload.reference,
        formUrl,
        formId,
        patient: {
          name: String(payload.patient?.name ?? '').trim(),
          dob: patientDob,
        },
      };
    }

    await clickConsentOption(page, q2, 'Approve');

    const downloadButton = page.getByRole('button', { name: 'Download document' });

    const submitStart = performance.now();

    await clickComplete(page);
    await expectVisibleWithDebug(downloadButton, page, 'Download button after submit');

    const submitDurationMs = performance.now() - submitStart;
    events.emit('histogram', 'aob.submit_to_download_button.duration', submitDurationMs);
    events.emit('counter', 'aob.submit_to_download_button.success', 1);

    if (formCompletionPath === 'download') {
      await humanPause(page, 500, 1500);

      const downloadStart = performance.now();

      // Old popup sequence for reference:
      // await downloadButton.click();
      // const downloadPage = await page.waitForEvent('popup');
      const [downloadPage] = await Promise.all([
        page.waitForEvent('popup', { timeout: 60000 }),
        downloadButton.click(),
      ]);

      // In headless/container environments the download popup may never reach a
      // normal load state (for example blob/download URLs). Treat "popup opened
      // and remained open briefly" as success.
      await downloadPage.waitForTimeout(1000);

      if (downloadPage.isClosed()) {
        throw new Error('Download popup closed before it became observable.');
      }

      await verifyDownloadedDocumentPatient(page, downloadPage, payload, events);

      const downloadOpenDurationMs = performance.now() - downloadStart;
      events.emit('histogram', 'aob.download_click_to_popup_ready.duration', downloadOpenDurationMs);
      events.emit('counter', 'aob.download_click_to_popup_ready.success', 1);

      return {
        tenantId,
        apiKey: bearerToken,
        reference: payload.reference,
        formUrl,
        formId,
        patient: {
          name: String(payload.patient?.name ?? '').trim(),
          dob: patientDob,
        },
      };
    }

    await expectVisibleWithDebug(downloadButton, page, 'Download button for no-download path');
    events.emit('counter', 'aob.no_download.completed', 1);

    return {
      tenantId,
      apiKey: bearerToken,
      reference: payload.reference,
      formUrl,
      formId,
      patient: {
        name: String(payload.patient?.name ?? '').trim(),
        dob: patientDob,
      },
    };
  } finally {
    await apiContext.dispose();
  }
}
