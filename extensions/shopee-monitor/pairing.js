// Formatting only, not authentication. The server still checks the secret hash.
export function normalizePairingToken(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g, '').toLowerCase();
}
export function validatePairingToken(value) {
  const token = normalizePairingToken(value);
  if (!token) throw new Error('尚未貼上配對碼。請回監控 APP 按「複製配對碼」，再貼到這裡。');
  if (/[•●·＊*]/.test(token)) throw new Error('貼到的是遮罩符號，不是配對碼。請使用監控 APP 的「複製配對碼」按鈕。');
  if (token.length !== 64) throw new Error(`配對碼不完整：目前 ${token.length} 字元，應為 64 字元。請重新複製整串，不要手動抄寫。`);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('配對碼含有非預期字元；只應包含 0–9 與 a–f。請複製配對碼，不要複製網址或欄位說明。');
  return token;
}
