// Read-only Git content audit. Never prints secret values or raw failing lines.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean))];
const privateRootArg = process.argv.indexOf('--private-root');
const privateRoot = privateRootArg >= 0 ? path.resolve(process.argv[privateRootArg + 1] || '') : null;
const knownValues = new Set();
if (privateRoot) {
  const env = fs.readFileSync(path.join(privateRoot, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const match = line.match(/^\s*[A-Z0-9_]+\s*=\s*(.+)/);
    if (match) {
      const value = match[1].trim().replace(/^['"]|['"]$/g, '');
      if (value.length >= 8) knownValues.add(value);
    }
  }
  const directory = path.join(privateRoot, 'data', 'private-purchase');
  const key = fs.readFileSync(path.join(directory, '.credential-key'));
  const envelope = JSON.parse(fs.readFileSync(path.join(directory, 'credentials.enc.json'), 'utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const credentials = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
  function collect(value, key = '') {
    if (typeof value === 'string' && value.trim().length >= 5 && /account|email|password|phone|name|address|token|cookie/i.test(key)) knownValues.add(value.trim());
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, k);
  }
  collect(credentials);
}

const forbidden = /^(?:data|records|logs|artifacts|node_modules|test-results|playwright-report)\/|^\.private-import-|^config\.json$|^\.env(?:\.|$)(?!example$)|(?:^|\/)\.credential-key$|\.(?:exe|dll|pdb|pem|key|kwkey|kenvault|har|zip|bundle|dmp|nupkg)$/i;
const secretPatterns = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /AKIA[A-Z0-9]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{15,}\/[A-Za-z0-9_-]{40,}/
];
const findings = [];
for (const relative of files) {
  if (forbidden.test(relative)) findings.push({ file: relative, kind: 'private_or_generated_path' });
  const file = path.join(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !/\.(?:md|json|js|mjs|cjs|html|txt|cs|ps1|vbs|bat|cmd)$|^\.env\.example$/.test(relative)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (secretPatterns.some(pattern => pattern.test(line))) findings.push({ file: relative, line: index + 1, kind: 'credential_format' });
    if ([...knownValues].some(value => line.includes(value))) findings.push({ file: relative, line: index + 1, kind: 'known_private_value' });
  });
}
console.log(JSON.stringify({ files: files.length, privateFingerprintCheck: Boolean(privateRoot),
  findings: findings.length, locations: findings }, null, 2));
if (findings.length) process.exitCode = 1;
