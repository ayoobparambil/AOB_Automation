# AOB Automation

Standalone Playwright UI automation for the AOB end-to-end browser flow.

## Setup

```powershell
npm install
```

Place the approved test data files in this folder before running live tests:

- `deploy.csv` for form deployment and browser completion tests
- `search-input.csv` for search and mixed workflow tests

## Build

```powershell
npm run build
```

## List Tests

```powershell
npm run test:list
```

## Run Browser Test

```powershell
npm run test
```

Each run creates:

- `business-report/index.html` for the business-facing summary
- `playwright-report/index.html` for the detailed Playwright report

The tests run in a visible Chromium browser. They cover:

- deploy an AOB form and approve without downloading
- deploy an AOB form, approve it, and open the download document
- deploy an AOB form and complete the decline path
- submit an AOB form, then search for the same submitted form id
- complete an AOB form with download, then validate the seeded AOB search endpoint using `search-input.csv`

Run one workflow at a time:

```powershell
npm run test:approve
npm run test:download
npm run test:decline
npm run test:submit-search
npm run test:seeded-search
```

Run only the submit-to-database and same-form search verification:

```powershell
npm run test:submit-search
```

Run only the seeded mixed search workflow:

```powershell
npm run test:seeded-search
```

Optional:

```powershell
$env:PLAYWRIGHT_SLOW_MO_MS = "250"
npm run test
```
