import { type Locator, type Page } from '@playwright/test';
import type { Events } from './aobTypes';

export function randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function humanPause(page: Page, min: number, max: number): Promise<void> {
    const delay = randomBetween(min, max);
    await page.waitForTimeout(delay);
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
    locator: Locator,
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

function postLoginFormReadyLocator(page: Page): Locator {
    return page
        .locator('body')
        .filter({
            hasText:
                /Bulk Bill Assignment of Benefit Agreement|Is the assignor the patient\?|Do you consent to assign the medicare benefit\?/i,
        })
        .filter({ has: page.getByText(/^(Yes|Approve|Decline)$/) });
}

export function dobToAccessCode(dob: string): string {
    const match = dob.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

    if (!match) {
        throw new Error(`DOB is not in expected DD/MM/YYYY format: ${dob}`);
    }

    const [, dd, mm, yyyy] = match;
    const yy = yyyy.slice(-2);

    return `${dd}${mm}${yy}`;
}

export function toDobValidationDigits(dob: string): string[] {
    return dobToAccessCode(dob).split('');
}

export function randomDigits(length: number): string {
    let value = '';

    for (let i = 0; i < length; i++) {
        value += Math.floor(Math.random() * 10).toString();
    }

    return value;
}

// Add this to aobHelpers.ts
export async function performSuccessfulLogin(
    page: Page,
    events: Events,
    accessCode: string
): Promise<void> {
    // 1. Fill the code
    await fillSixDigitCode(page, accessCode);
    await humanPause(page, 500, 1200);

    // 2. Start measurement
    const loginStart = performance.now();

    // 3. Action
    await page.getByRole('button', { name: 'Continue' }).click();

    // 4. Wait for either valid post-login state. Some forms land directly on
    // the current Bulk Bill consent page without showing the older question text.
    await expectVisibleWithDebug(
        postLoginFormReadyLocator(page),
        page,
        'Post-login form question'
    );

    // 5. Emit unified metrics
    const loginDurationMs = performance.now() - loginStart;
    events.emit('histogram', 'aob.valid_form_load.duration', loginDurationMs);
    events.emit('counter', 'aob.valid_form_load.count', 1);
}


export function randomIncorrectAccessCode(correctAccessCode: string): string {
    let candidate = randomDigits(6);

    while (candidate === correctAccessCode) {
        candidate = randomDigits(6);
    }

    return candidate;
}

export function parsePayloadJson<T>(rawPayloadJson: string): T {
    try {
        return JSON.parse(rawPayloadJson) as T;
    } catch {
        throw new Error(`Failed to parse payloadJson from deploy.csv. Value: ${rawPayloadJson}`);
    }
}

export async function fillSixDigitCode(page: Page, code: string): Promise<void> {
    if (!/^\d{6}$/.test(code)) {
        throw new Error(`Expected a 6 digit code but received: ${code}`);
    }

    const digits = code.split('');

    const fieldSelectors = [
        '#TextField4',
        '#TextField9',
        '#TextField14',
        '#TextField19',
        '#TextField24',
        '#TextField29',
    ];

    const legacyFirstField = page.locator(fieldSelectors[0]);

    if (await legacyFirstField.isVisible().catch(() => false)) {
        for (let i = 0; i < fieldSelectors.length; i++) {
            await page.locator(fieldSelectors[i]).fill(digits[i]);
            await humanPause(page, 100, 300);
        }

        return;
    }

    const textboxes = page.getByRole('textbox');
    const visibleTextboxes = [];
    const textboxCount = await textboxes.count();

    for (let i = 0; i < textboxCount && visibleTextboxes.length < digits.length; i++) {
        const textbox = textboxes.nth(i);

        if (await textbox.isVisible().catch(() => false)) {
            visibleTextboxes.push(textbox);
        }
    }

    if (visibleTextboxes.length < digits.length) {
        throw new Error(`Expected 6 visible digit inputs but found ${visibleTextboxes.length}.`);
    }

    for (let i = 0; i < digits.length; i++) {
        await visibleTextboxes[i].fill(digits[i]);
        await humanPause(page, 100, 300);
    }
}

export async function fillDobValidation(page: Page, dob: string): Promise<void> {
    await fillSixDigitCode(page, dobToAccessCode(dob));
}

export function pickWeighted<T extends string>(weights: Record<T, number>): T {
    const total = Object.values(weights).reduce((sum: number, value: unknown) => {
        return sum + (value as number);
    }, 0);

    const roll = Math.random() * total;

    let cumulativeWeight = 0;
    for (const [key, weight] of Object.entries(weights)) {
        cumulativeWeight += (weight as number);
        if (roll < cumulativeWeight) {
            return key as T; // Return as the specific key type
        }
    }
    // Fallback: return the first key found in the object
    return Object.keys(weights)[0] as T;
}
