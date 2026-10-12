// One shared budget, not one fresh timeout per request. Never races an in-flight write.
export function purchaseRequestBudget(api, { deadlineMs = 30000, now = Date.now, onDispatch = () => {} } = {}) {
  const started = now();
  const duration = Math.max(1, Math.min(Number(deadlineMs) || 30000, 30000));
  const check = () => {
    const remaining = duration - (now() - started);
    if (remaining <= 0) throw Object.assign(new Error('本次 API 任務已達總時間上限，未送出新的請求'), { purchaseStatus: 'deadline_exceeded', requestNotDispatched: true });
    return remaining;
  };
  const request = new Proxy(api, { get(target, name) {
    if (['get', 'post', 'put', 'patch', 'delete', 'head'].includes(name)) return (url, options = {}) => {
      const remaining = check();
      const timeout = Math.max(1, Math.min(Number(options.timeout) || remaining, remaining));
      onDispatch(name, url);
      return target[name](url, { ...options, timeout });
    };
    const value = target[name];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { request, check, elapsedMs: () => Math.max(0, now() - started), durationMs: duration };
}
