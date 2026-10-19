// Test-process guard, not a system sandbox. It never changes the production service.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url))).toLowerCase();
const within = (target, base) => target === base || target.startsWith(base + path.sep);
const blocked = () => Object.assign(new Error('COMMERCE_ACCEPTANCE_EXTERNAL_IO_BLOCKED'), { code: 'ACCEPTANCE_IO_BLOCKED' });
const filename = value => typeof value === 'number' ? '' : path.resolve(value instanceof URL ? fileURLToPath(value) : String(value)).toLowerCase();
function protectRead(value) {
  const target = filename(value);
  if (!target || !within(target, root)) return;
  const relative = path.relative(root, target).replaceAll('\\', '/');
  if (/^(?:\.env(?:\.|$)|config\.json$|state\.json(?:\.|$)|data\/(?:auto-purchase|records)(?:\/|$)|logs(?:\/|$))/.test(relative)) throw blocked();
}
function protectWrite(value) {
  const target = filename(value), temp = path.resolve(os.tmpdir()).toLowerCase();
  if (!target || within(target, temp) || within(target, path.join(root, 'test')) && /[\\/]nonexistent[^\\/]*/.test(target)) return;
  throw blocked();
}
for (const method of ['readFile', 'readFileSync', 'createReadStream']) {
  const original = fs[method]; fs[method] = function(value, ...args) { protectRead(value); return original.call(this, value, ...args); };
}
for (const method of ['readFile']) {
  const original = fsp[method]; fsp[method] = async function(value, ...args) { protectRead(value); return original.call(this, value, ...args); };
}
for (const method of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'unlink', 'unlinkSync', 'createWriteStream']) {
  const original = fs[method]; fs[method] = function(value, ...args) { protectWrite(value); return original.call(this, value, ...args); };
}
for (const method of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile']) {
  const original = fsp[method]; fsp[method] = async function(value, ...args) {
    protectWrite(value); if (['rename', 'copyFile'].includes(method)) protectWrite(args[0]); return original.call(this, value, ...args);
  };
}
function endpoint(host, port) {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host || 'localhost').toLowerCase()) || Number(port) === 3210) throw blocked();
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options = values[0];
  if (typeof options === 'object') {
    if (options.path) throw blocked(); endpoint(options.host, options.port);
  } else {
    if (!Number.isFinite(Number(options))) throw blocked();
    endpoint(typeof values[1] === 'string' ? values[1] : 'localhost', options);
  }
  return connect.apply(this, args);
};
const tlsConnect = tls.connect;
tls.connect = function(...args) {
  const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  endpoint(options.host, options.port); return tlsConnect.apply(this, args);
};
for (const module of [http, https]) for (const method of ['request', 'get']) {
  const original = module[method]; module[method] = function(input, ...args) {
    if (typeof input === 'string' || input instanceof URL) { const url = new URL(input); endpoint(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80)); }
    else endpoint(input?.hostname || input?.host, input?.port || (module === https ? 443 : 80));
    return original.call(this, input, ...args);
  };
}
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (input, ...args) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  endpoint(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80)); return fetchOriginal(input, ...args);
};
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[method]; childProcess[method] = function(command, ...args) {
    if (path.resolve(command).toLowerCase() !== process.execPath.toLowerCase()) throw blocked();
    return original.call(this, command, ...args);
  };
}
for (const method of ['exec', 'execSync']) childProcess[method] = () => { throw blocked(); };
syncBuiltinESMExports();
process.env.COMMERCE_ACCEPTANCE_GUARDED = '1';
