import type { Events } from '../src/aobTypes';

export class TestEvents implements Events {
  private readonly metrics: string[] = [];

  emit(eventType: string, name: string | number, value = 1): void {
    this.metrics.push(`${eventType}:${String(name)}:${value}`);
  }

  toString(): string {
    return this.metrics.join('\n');
  }
}

export async function attachMetrics(
  attach: (name: string, options: { body: string; contentType: string }) => Promise<void>,
  name: string,
  events: TestEvents
): Promise<void> {
  await attach(name, {
    body: events.toString() || 'No metrics emitted.',
    contentType: 'text/plain',
  });
}
