import { SxmlParser, SxmlResult, SxmlConfig } from '../src/index';

export function collectSync(chunks: string[], config?: SxmlConfig): SxmlResult[] {
  const parser = new SxmlParser(config ?? { legalTags: ['think'] });
  const results: SxmlResult[] = [];

  for (const chunk of chunks) {
    parser.write(chunk);
    let result: SxmlResult | null;
    while ((result = parser.tryPull()) !== null) {
      results.push(result);
    }
  }
  parser.end();
  let result: SxmlResult | null;
  while ((result = parser.tryPull()) !== null) {
    results.push(result);
  }

  return results;
}

export function buildEvents(results: SxmlResult[]) {
  const events: any[] = [];
  for (const r of results) {
    if (r.update === null) {
      events.pop();
    } else if (r.update !== undefined) {
      events[events.length - 1] = r.update;
    }
    events.push(...r.append);
  }
  return events;
}
