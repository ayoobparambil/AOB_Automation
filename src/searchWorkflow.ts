import { request as playwrightRequest, type Page } from '@playwright/test';
import type { AobCompletionResult, Events, SearchInputRow, VuContext } from './aobTypes';
import { nextRowFromPool } from './testData';

const DEFAULT_BASE_URL = 'https://stage.bponline.dev';
const DEFAULT_SEARCH_PATH = '/api/pracsvcs/forms/aob/$search';
const DEFAULT_SEARCH_METHOD = 'GET';
const RESPONSE_SNIPPET_LIMIT = 500;

function resolveSearchRow(vuContext: VuContext): SearchInputRow {
  const existingPayloadJson = String(vuContext?.vars?.SearchPayloadJson ?? '').trim();

  if (existingPayloadJson) {
    return vuContext.vars as unknown as SearchInputRow;
  }

  return nextRowFromPool<SearchInputRow>('search-input', 'search-input.csv');
}

function getAbsoluteUrl(baseUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  return new URL(pathOrUrl, baseUrl).toString();
}

function resolveSearchBaseUrl(searchPath: string): string {
  const configuredBaseUrl = process.env.AOB_SEARCH_BASE_URL ?? process.env.AOB_BASE_URL ?? DEFAULT_BASE_URL;

  if (!searchPath.startsWith('/api/')) {
    return configuredBaseUrl;
  }

  const url = new URL(configuredBaseUrl);

  if (/^forms\./i.test(url.hostname)) {
    url.hostname = url.hostname.replace(/^forms\./i, '');
    return url.toString();
  }

  return configuredBaseUrl;
}

function buildSearchUrl(searchUrl: string, payload: Record<string, unknown>): string {
  const url = new URL(searchUrl);

  for (const [key, rawValue] of Object.entries(payload)) {
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) {
        url.searchParams.append(key, String(value));
      }
      continue;
    }

    if (rawValue !== null && rawValue !== undefined) {
      url.searchParams.append(key, String(rawValue));
    }
  }

  return url.toString();
}

function buildResponseSnippet(responseText: string): string {
  const normalized = responseText.replace(/\s+/g, ' ').trim();
  return normalized.slice(0, RESPONSE_SNIPPET_LIMIT) || 'n/a';
}

export async function runSearchScenario(
  _page: Page,
  vuContext: VuContext,
  events: Events
): Promise<void> {
  const searchRow = resolveSearchRow(vuContext);
  const searchPath = process.env.AOB_SEARCH_PATH ?? DEFAULT_SEARCH_PATH;
  const baseUrl = resolveSearchBaseUrl(searchPath);
  const searchMethod = (process.env.AOB_SEARCH_METHOD ?? DEFAULT_SEARCH_METHOD).toUpperCase();
  const baseSearchUrl = getAbsoluteUrl(baseUrl, searchPath);
  const payload = JSON.parse(searchRow.SearchPayloadJson) as Record<string, unknown>;
  const searchUrl = searchMethod === 'GET'
    ? buildSearchUrl(baseSearchUrl, payload)
    : baseSearchUrl;

  const apiContext = await playwrightRequest.newContext({
    extraHTTPHeaders: {
      Authorization: `Bearer ${searchRow.APIKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  try {
    events.emit('counter', 'aob.search.started', 1);

    const searchStart = Date.now();
    const response = await apiContext.fetch(searchUrl, {
      method: searchMethod,
      ...(searchMethod === 'GET' ? {} : { data: payload }),
    });

    const durationMs = Date.now() - searchStart;
    const responseText = await response.text();
    const status = response.status();

    events.emit('histogram', 'aob.search.duration', durationMs);
    events.emit('counter', `aob.search.status.${status}`, 1);

    if (status < 200 || status >= 300) {
      events.emit('counter', 'aob.search.failed', 1);
      throw new Error(
        `Search failed. Url=${searchUrl}, Method=${searchMethod}, Tenant=${searchRow.TenantId}, Reference=${searchRow.Reference}, FormId=${searchRow.FormId}, Status=${status}, Payload=${JSON.stringify(payload)}, Body=${responseText}`
      );
    }

    const expectedContainsValues = String(searchRow.ExpectedContainsCsv ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    const missingExpectedValues = expectedContainsValues.filter((value) => !responseText.includes(value));

    if (expectedContainsValues.length > 0 && missingExpectedValues.length === 0) {
      events.emit('counter', 'aob.search.correct_match', 1);
    } else if (expectedContainsValues.length > 0) {
      events.emit('counter', 'aob.search.missing_expected_result', 1);
      throw new Error(
        `Search response did not contain all expected values. Url=${searchUrl}, Method=${searchMethod}, Tenant=${searchRow.TenantId}, Reference=${searchRow.Reference}, FormIds=${searchRow.FormIdsCsv}, Expected=${searchRow.ExpectedContainsCsv}, Missing=${missingExpectedValues.join(',')}, Payload=${JSON.stringify(payload)}, Status=${status}, ResponseSnippet=${buildResponseSnippet(responseText)}`
      );
    } else {
      events.emit('counter', 'aob.search.completed_without_assertion', 1);
    }
  } finally {
    await apiContext.dispose();
  }
}

export async function runSearchForCompletedAob(
  completedForm: AobCompletionResult,
  events: Events
): Promise<void> {
  if (!completedForm.formId) {
    throw new Error(
      `Cannot search completed AOB form because deploy response did not contain a form id. Reference=${completedForm.reference}, FormUrl=${completedForm.formUrl}`
    );
  }

  const searchPath = process.env.AOB_SEARCH_PATH ?? DEFAULT_SEARCH_PATH;
  const baseUrl = resolveSearchBaseUrl(searchPath);
  const searchMethod = (process.env.AOB_SEARCH_METHOD ?? DEFAULT_SEARCH_METHOD).toUpperCase();
  const baseSearchUrl = getAbsoluteUrl(baseUrl, searchPath);
  const payload = { id: completedForm.formId };
  const searchUrl = searchMethod === 'GET'
    ? buildSearchUrl(baseSearchUrl, payload)
    : baseSearchUrl;

  const apiContext = await playwrightRequest.newContext({
    extraHTTPHeaders: {
      Authorization: `Bearer ${completedForm.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  try {
    events.emit('counter', 'aob.completed_form_search.started', 1);

    const searchStart = Date.now();
    const response = await apiContext.fetch(searchUrl, {
      method: searchMethod,
      ...(searchMethod === 'GET' ? {} : { data: payload }),
    });

    const durationMs = Date.now() - searchStart;
    const responseText = await response.text();
    const status = response.status();

    events.emit('histogram', 'aob.completed_form_search.duration', durationMs);
    events.emit('counter', `aob.completed_form_search.status.${status}`, 1);

    if (status < 200 || status >= 300) {
      events.emit('counter', 'aob.completed_form_search.failed', 1);
      throw new Error(
        `Completed form search failed. Url=${searchUrl}, Method=${searchMethod}, Tenant=${completedForm.tenantId}, Reference=${completedForm.reference}, FormId=${completedForm.formId}, Status=${status}, Body=${responseText}`
      );
    }

    const expectedValues = [
      completedForm.formId,
      '"submittedDate"',
      '"medicareConsent":true',
    ];
    const missingExpectedValues = expectedValues.filter((value) => !responseText.includes(value));

    if (missingExpectedValues.length > 0) {
      events.emit('counter', 'aob.completed_form_search.missing_expected_result', 1);
      throw new Error(
        `Completed form search response did not contain expected submitted form values. Url=${searchUrl}, Tenant=${completedForm.tenantId}, Reference=${completedForm.reference}, FormId=${completedForm.formId}, Missing=${missingExpectedValues.join(',')}, Status=${status}, ResponseSnippet=${buildResponseSnippet(responseText)}`
      );
    }

    events.emit('counter', 'aob.completed_form_search.correct_match', 1);
  } finally {
    await apiContext.dispose();
  }
}
