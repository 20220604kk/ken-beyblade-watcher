export function accountIdentity(value) {
  return String(value || '').normalize('NFKC').replace(/^(?:你好|您好|こんにちは|こんばんは|Hello|Hi)[,，、\s]*/i, '')
    .replace(/さん\s*$/, '').replace(/\s+/g, '').trim();
}
