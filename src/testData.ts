import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

type CsvRow = Record<string, string>;

type PoolState<T extends CsvRow> = {
    index: number;
    rows: T[];
};

const pools = new Map<string, PoolState<CsvRow>>();

export function resolveRepoPath(fileName: string): string {
    return path.resolve(process.cwd(), fileName);
}

export function parseCsvFile<T extends CsvRow>(fileName: string): T[] {
    const filePath = resolveRepoPath(fileName);

    if (!fs.existsSync(filePath)) {
        throw new Error(`Could not find CSV file at: ${filePath}`);
    }

    const csvText = fs.readFileSync(filePath, 'utf8');

    return parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }) as T[];
}

export function writeCsvFile(fileName: string, headers: string[], rows: Array<Record<string, unknown>>): void {
    const filePath = resolveRepoPath(fileName);
    const lines: string[] = [headers.map(escapeCsv).join(',')];

    for (const row of rows) {
        lines.push(headers.map((header) => escapeCsv(row[header] ?? '')).join(','));
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

export function escapeCsv(value: unknown): string {
    const str = String(value ?? '');

    if (
        str.includes('"') ||
        str.includes(',') ||
        str.includes('\n') ||
        str.includes('\r')
    ) {
        return `"${str.replace(/"/g, '""')}"`;
    }

    return str;
}

export function getJsonPathValue(input: unknown, rawPath: string): unknown {
    if (!rawPath) {
        return undefined;
    }

    const pathSegments = rawPath
        .split('.')
        .map((segment) => segment.trim())
        .filter(Boolean);

    let current: unknown = input;

    for (const segment of pathSegments) {
        if (current === null || current === undefined || typeof current !== 'object') {
            return undefined;
        }

        current = (current as Record<string, unknown>)[segment];
    }

    return current;
}

export function interpolateTemplate(template: string, values: Record<string, unknown>): string {
    return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
        const value = values[key];
        return value === null || value === undefined ? '' : String(value);
    });
}

export function nextRowFromPool<T extends CsvRow>(poolName: string, fileName: string): T {
    const existing = pools.get(poolName) as PoolState<T> | undefined;

    if (existing) {
        const row = existing.rows[existing.index % existing.rows.length];
        existing.index += 1;
        return row;
    }

    const rows = parseCsvFile<T>(fileName);

    if (rows.length === 0) {
        throw new Error(`CSV pool ${poolName} from ${fileName} has no usable rows.`);
    }

    const state: PoolState<T> = {
        index: 1,
        rows,
    };

    pools.set(poolName, state as PoolState<CsvRow>);
    return rows[0];
}
