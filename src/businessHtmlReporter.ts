import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

type BusinessResult = {
  businessRule: string;
  durationMs: number;
  error: string;
  workflows: string[];
  status: TestResult['status'];
  testCase: string;
};

const REPORT_DIR = 'playwright-report';
const REPORT_FILE = 'index.html';
const REPORT_PDF_FILE = 'report.pdf';

async function exportReportPdf(reportPath: string): Promise<string | undefined> {
  if (process.env.AOB_EXPORT_REPORT_PDF === '0') {
    return undefined;
  }

  const pdfPath = path.join(path.dirname(reportPath), REPORT_PDF_FILE);
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

    await page.goto(pathToFileURL(reportPath).toString(), { waitUntil: 'networkidle' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '12mm',
        right: '10mm',
        bottom: '12mm',
        left: '10mm',
      },
    });

    return pdfPath;
  } finally {
    await browser.close();
  }
}

function openReportInBrowser(reportPath: string): void {
  if (process.env.CI || process.env.AOB_OPEN_REPORT === '0') {
    return;
  }

  const command =
    process.platform === 'win32'
      ? 'cmd'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const args =
    process.platform === 'win32'
      ? ['/c', 'start', '', reportPath]
      : [reportPath];

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  child.unref();
}

function businessRuleFor(test: TestCase): string {
  const title = test.title.toLowerCase();

  if (title.includes('approve path without download')) {
    return 'Form approval without document download';
  }

  if (title.includes('opens the download document')) {
    return 'Form approval with document download';
  }

  if (title.includes('decline path')) {
    return 'Form decline workflow';
  }

  if (title.includes('same form in search')) {
    return 'Submitted form search validation';
  }

  if (title.includes('seeded mixed search')) {
    return 'Mixed submit and seeded search workflow';
  }

  return test.title;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  return `${(durationMs / 1000).toFixed(1)} s`;
}

function statusLabel(status: TestResult['status']): string {
  if (status === 'passed') {
    return 'PASS';
  }

  if (status === 'failed' || status === 'timedOut') {
    return 'FAIL';
  }

  return status.toUpperCase();
}

function statusClass(status: TestResult['status']): string {
  if (status === 'passed') {
    return 'pass';
  }

  if (status === 'failed' || status === 'timedOut') {
    return 'fail';
  }

  return 'other';
}

function metricsTextFor(result: TestResult): string {
  return result.attachments
    .map((attachment) => attachment.body?.toString('utf8') ?? '')
    .filter(Boolean)
    .join('\n');
}

function hasMetric(metricsText: string, metricName: string): boolean {
  return metricsText.includes(metricName);
}

function workflowSummaryFor(test: TestCase, result: TestResult): string[] {
  const title = test.title.toLowerCase();
  const metricsText = metricsTextFor(result);
  const workflows: string[] = [];

  if (hasMetric(metricsText, 'aob.deploy.status.')) {
    workflows.push('Deployed AOB form');
  }

  if (
    hasMetric(metricsText, 'aob.dob_validation_path.second_attempt') ||
    hasMetric(metricsText, 'aob.dob_validation_path.third_attempt')
  ) {
    workflows.push('Validated incorrect DOB retry');
  }

  workflows.push('Validated DOB');

  if (hasMetric(metricsText, 'aob.form_completion_path.decline') || title.includes('decline path')) {
    workflows.push('Declined form and verified confirmation');
  } else {
    workflows.push('Approved form');
  }

  if (hasMetric(metricsText, 'aob.no_download.completed') || title.includes('without download')) {
    workflows.push('Completed approval without download');
  }

  if (
    hasMetric(metricsText, 'aob.download_click_to_popup_ready.success') ||
    hasMetric(metricsText, 'aob.download.patient_match.success') ||
    title.includes('download document')
  ) {
    workflows.push('Opened download document');
  }

  if (
    hasMetric(metricsText, 'aob.completed_form_search.correct_match') ||
    title.includes('same form in search')
  ) {
    workflows.push('Verified submitted form in search');
  }

  if (
    hasMetric(metricsText, 'aob.search.correct_match') ||
    title.includes('seeded mixed search')
  ) {
    workflows.push('Validated seeded search results');
  }

  return Array.from(new Set(workflows));
}

function renderReport(results: BusinessResult[], startedAt: Date, completedAt: Date): string {
  const total = results.length;
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.filter((result) => result.status === 'failed' || result.status === 'timedOut').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const durationMs = completedAt.getTime() - startedAt.getTime();
  const passRate = total === 0 ? 0 : Math.round((passed / total) * 100);
  const generatedAt = completedAt.toLocaleString();

  const rows = results.map((result, index) => {
    const workflowItems = result.workflows
      .map((workflow) => `<li>${escapeHtml(workflow)}</li>`)
      .join('');
    const errorBlock = result.error
      ? `<details><summary>Failure details</summary><pre>${escapeHtml(result.error)}</pre></details>`
      : '<span class="muted">No failure</span>';

    return `
      <tr>
        <td class="index">${index + 1}</td>
        <td>
          <div class="rule">${escapeHtml(result.businessRule)}</div>
          <div class="test-name">${escapeHtml(result.testCase)}</div>
          <ul class="workflow-list">${workflowItems}</ul>
        </td>
        <td><span class="badge ${statusClass(result.status)}">${statusLabel(result.status)}</span></td>
        <td>${formatDuration(result.durationMs)}</td>
        <td>${errorBlock}</td>
      </tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AOB Automation Business Report</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7fb;
      --panel: #ffffff;
      --ink: #1b2430;
      --muted: #667085;
      --line: #d9dee8;
      --pass: #087443;
      --pass-bg: #dcfae6;
      --fail: #b42318;
      --fail-bg: #fee4e2;
      --other: #475467;
      --other-bg: #eef2f6;
      --accent: #175cd3;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 "Segoe UI", Arial, sans-serif;
    }

    .page {
      max-width: 1180px;
      margin: 0 auto;
      padding: 32px 24px 48px;
    }

    header {
      margin-bottom: 24px;
    }

    h1 {
      margin: 0 0 8px;
      font-size: 30px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .subtitle {
      color: var(--muted);
      font-size: 15px;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(5, minmax(130px, 1fr));
      gap: 12px;
      margin: 22px 0 24px;
    }

    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      box-shadow: 0 1px 2px rgb(16 24 40 / 5%);
    }

    .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }

    .value {
      margin-top: 6px;
      font-size: 26px;
      font-weight: 700;
    }

    .value.pass-text { color: var(--pass); }
    .value.fail-text { color: var(--fail); }

    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      overflow: hidden;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 1px 2px rgb(16 24 40 / 5%);
    }

    th, td {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }

    th {
      background: #f9fafb;
      color: #344054;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }

    tr:last-child td {
      border-bottom: 0;
    }

    .index {
      width: 44px;
      color: var(--muted);
    }

    .rule {
      font-weight: 650;
      margin-bottom: 4px;
    }

    .test-name {
      color: var(--muted);
      font-size: 13px;
    }

    .workflow-list {
      margin: 10px 0 0;
      padding-left: 18px;
      color: #344054;
    }

    .workflow-list li {
      margin: 3px 0;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 64px;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 700;
    }

    .badge.pass { background: var(--pass-bg); color: var(--pass); }
    .badge.fail { background: var(--fail-bg); color: var(--fail); }
    .badge.other { background: var(--other-bg); color: var(--other); }

    .muted {
      color: var(--muted);
    }

    details {
      max-width: 460px;
    }

    summary {
      color: var(--accent);
      cursor: pointer;
      font-weight: 600;
    }

    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #101828;
      color: #f2f4f7;
      border-radius: 8px;
      padding: 12px;
      max-height: 280px;
      overflow: auto;
    }

    @media (max-width: 900px) {
      .summary {
        grid-template-columns: repeat(2, minmax(130px, 1fr));
      }

      table {
        display: block;
        overflow-x: auto;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <header>
      <h1>AOB Automation Business Report</h1>
      <div class="subtitle">Generated ${escapeHtml(generatedAt)}. Browser E2E validation for AOB business workflows.</div>
    </header>

    <section class="summary" aria-label="Run summary">
      <div class="card"><div class="label">Total Tests</div><div class="value">${total}</div></div>
      <div class="card"><div class="label">Passed</div><div class="value pass-text">${passed}</div></div>
      <div class="card"><div class="label">Failed</div><div class="value fail-text">${failed}</div></div>
      <div class="card"><div class="label">Skipped</div><div class="value">${skipped}</div></div>
      <div class="card"><div class="label">Pass Rate</div><div class="value">${passRate}%</div></div>
    </section>

    <section class="card" style="margin-bottom: 16px;">
      <div class="label">Run Duration</div>
      <div class="value" style="font-size: 20px;">${formatDuration(durationMs)}</div>
    </section>

    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Main Workflow</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="5" class="muted">No tests were executed.</td></tr>'}
      </tbody>
    </table>
  </main>
</body>
</html>`;
}

class BusinessHtmlReporter implements Reporter {
  private readonly results: BusinessResult[] = [];
  private startedAt = new Date();
  private reportPath = '';

  onBegin(_config: FullConfig): void {
    this.startedAt = new Date();
    const outputDir = path.resolve(process.cwd(), REPORT_DIR);
    fs.mkdirSync(outputDir, { recursive: true });
    this.reportPath = path.join(outputDir, REPORT_FILE);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.results.push({
      businessRule: businessRuleFor(test),
      durationMs: result.duration,
      error: result.errors.map((error) => error.message || String(error)).join('\n\n'),
      workflows: workflowSummaryFor(test, result),
      status: result.status,
      testCase: test.titlePath().slice(1).join(' > '),
    });
  }

  async onEnd(_result: FullResult): Promise<void> {
    const completedAt = new Date();
    fs.writeFileSync(this.reportPath, renderReport(this.results, this.startedAt, completedAt), 'utf8');
    console.log(`\nAOB business report: ${this.reportPath}`);

    try {
      const pdfPath = await exportReportPdf(this.reportPath);

      if (pdfPath) {
        console.log(`AOB business report PDF: ${pdfPath}`);
      }
    } catch (error) {
      console.warn(`AOB business report PDF was not created: ${String(error)}`);
    }

    openReportInBrowser(this.reportPath);
  }
}

export default BusinessHtmlReporter;
