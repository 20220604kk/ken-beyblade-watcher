import os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { monitoringResourceStats } from './monitoring-resources.js';
import { notificationMetrics } from './notification-metrics.js';

export function createRuntimeMetrics({ state, intervalMs = 5000 } = {}) {
  const delay = monitorEventLoopDelay({ resolution: 50 });
  delay.enable();
  const cores = Math.max(1, os.cpus().length);
  let previousCpu = process.cpuUsage();
  let previousAt = performance.now();
  let snapshot = { nodeCpuPercent: null, eventLoopP95Ms: null };
  const sample = () => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const elapsedMs = now - previousAt;
    const memory = process.memoryUsage();
    snapshot = {
      sampledAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      nodeCpuPercent: Number((((cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000) / elapsedMs / cores * 100).toFixed(2)),
      nodeRssMB: Math.round(memory.rss / 1048576),
      heapUsedMB: Math.round(memory.heapUsed / 1048576),
      // Histogram measures a 50ms timer; show excess scheduling delay.
      eventLoopP95Ms: Number(Math.max(0, delay.percentile(95) / 1e6 - 50).toFixed(1)),
      eventLoopMaxMs: Number(Math.max(0, delay.max / 1e6 - 50).toFixed(1)),
      stateWrites: state?.getSaveStats?.() || {},
      resources: monitoringResourceStats(),
      notifications: notificationMetrics(),
      scope: 'node-only'
    };
    previousCpu = cpu;
    previousAt = now;
    delay.reset();
  };
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return { snapshot: () => snapshot, close: () => { clearInterval(timer); delay.disable(); } };
}
