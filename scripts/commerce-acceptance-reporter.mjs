// Only test identity/status/location is exported: no assertion payloads or secrets.
export default async function* reporter(events) {
  for await (const event of events) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const d = event.data;
      yield JSON.stringify({ type: event.type, name: d.name, file: d.file, line: d.line,
        durationMs: d.details?.duration_ms, skipped: Boolean(d.skip), todo: Boolean(d.todo),
        errorCode: event.type === 'test:fail' ? d.details?.error?.code || 'TEST_FAILURE' : undefined }) + '\n';
    }
  }
}
