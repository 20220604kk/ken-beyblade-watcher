// Compatibility boundary for archived Facebook/form integration in index.js.
// No browser, profile, network, form submission or archive dependency is loaded.
export const FACEBOOK_ARCHIVE_NAME = '1010FB暫存';
const RETIRED_PATHS = new Set([
  '/scan', '/scan-hotspot', '/monitor/start', '/monitor/stop', '/facebook-login',
  '/google-login', '/google-login/additional', '/test-autofill', '/test-multi-autofill',
  '/prewarm-form', '/autofill-profile', '/api/autofill-profile', '/api/form-preview',
  '/form-preview.png', '/autofill-test-form', '/form-ai-settings', '/test-form-ai',
  '/hotspot', '/settings', '/keywords', '/pages', '/pages/rename', '/pages/detect-name',
  '/pages/enabled', '/pages/delete', '/test-post-notification', '/test-latest-sogo-post'
]);
export function isArchivedFacebookRequest(rawUrl) {
  const url = new URL(rawUrl, 'http://127.0.0.1');
  return RETIRED_PATHS.has(url.pathname)
    || (url.pathname === '/api/status' && url.searchParams.get('view') === 'fb');
}
export function enforceFacebookArchive(config) {
  // Ignore legacy resume-state attempts to enable Facebook.
  Object.defineProperty(config, 'monitoringEnabled', {
    enumerable: true, configurable: false, get: () => false, set: () => {}
  });
  config.pages = [];
  config.hotspot ||= {};
  for (const key of ['enabled', 'autoFillEnabled', 'autoSubmitEnabled']) {
    Object.defineProperty(config.hotspot, key, {
      enumerable: true, configurable: false, get: () => false, set: () => {}
    });
  }
}
export function withoutFacebookStatus(status) {
  const result = { ...status, notifications: { ...status.notifications } };
  for (const key of ['monitoringEnabled', 'interval', 'pageCount', 'totalPageCount',
    'pausedPageCount', 'pages', 'productKeywords', 'salesKeywords', 'notificationReady',
    'notificationChannel', 'browserMode', 'browserOpenPages', 'activeHours',
    'withinActiveHours', 'nextScanAt', 'scanning', 'lastScan', 'lastHotspotScan',
    'lastError', 'facebookCooldownUntil', 'hotspot', 'autoFill', 'lastMultiFill',
    'lastMultiFillDryRun', 'regularLogs', 'hotspotLogs']) delete result[key];
  for (const key of ['facebook', 'hotspot', 'facebookReady', 'hotspotReady',
    'facebookLabel', 'hotspotLabel']) delete result.notifications[key];
  return result;
}
export function activeProjectConfig(config) {
  const result = { ...config, notifications: { ...config.notifications },
    retiredFeatures: { ...config.retiredFeatures, facebook: FACEBOOK_ARCHIVE_NAME } };
  for (const key of ['pages', 'hotspot', 'scanIntervalMinutes', 'browserHeadless',
    'pageLoadSeconds', 'maxPostsPerPage', 'notifyExistingRelevantPostsOnFirstRun',
    'productKeywords', 'salesKeywords', 'formLinkPatterns']) delete result[key];
  delete result.notifications.facebook;
  delete result.notifications.hotspot;
  // Explicit false retained for backward compatibility and lifecycle tooling.
  result.monitoringEnabled = false;
  return result;
}
export function retireFacebookState(state) {
  state.seen = {};
  state.forms = {};
  state.initializedPages = {};
  delete state.lastScan;
  delete state.lastHotspotScan;
  delete state.facebookAccess;
}
export class FacebookScanner {
  getMode() { return 'archived'; }
  getOpenPageCount() { return 0; }
  async close() {}
}
export class Watcher {
  running = false;
  async scanAll() { throw new Error(`Facebook 已封存：${FACEBOOK_ARCHIVE_NAME}`); }
}
export class FormAutoFill {
  constructor({ profileSlot }) { this.slot = profileSlot; }
  async load() {}
  async close() {}
  getStatus() { return { slot: this.slot, browserOpen: false, profileReady: false,
    profiles: [], ai: { enabled: false, configured: false } }; }
}
