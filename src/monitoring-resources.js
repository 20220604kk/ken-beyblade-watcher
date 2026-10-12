const HEAVY_TYPES = new Set(['image', 'media', 'font']);
const TELEMETRY_HOST = /^https?:\/\/(?:[^/]+\.)?(?:google-analytics\.com|doubleclick\.net|googlesyndication\.com|scorecardresearch\.com|criteo\.com|criteo\.net|clarity\.ms)(?::\d+)?\//i;
const counters = { examined: 0, blockedAssets: 0, blockedTelemetry: 0 };

export function monitoringResourceDecision(type, url, { blockStyles = false } = {}) {
  if (HEAVY_TYPES.has(type) || (blockStyles && type === 'stylesheet')) return 'asset';
  if (TELEMETRY_HOST.test(url || '')) return 'telemetry';
  return 'allow';
}

// Monitoring contexts only. Purchase and interactive login contexts are untouched.
export function monitoringRoute(options = {}) {
  return async (route) => {
    const request = route.request();
    const decision = monitoringResourceDecision(request.resourceType(), request.url(), options);
    counters.examined += 1;
    if (decision === 'asset') counters.blockedAssets += 1;
    if (decision === 'telemetry') counters.blockedTelemetry += 1;
    try {
      if (decision === 'allow') await route.continue();
      else await route.abort();
    } catch (error) {
      if (!/closed|disposed|already handled/i.test(error.message)) throw error;
    }
  };
}

export function monitoringResourceStats() { return { ...counters }; }
