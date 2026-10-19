let accountLabel = '';
const $ = id => document.getElementById(id);
const show = value => { $('status').textContent = value; };
$('inspect').onclick = async () => {
  const result = await chrome.runtime.sendMessage({ type: 'inspect' });
  accountLabel = result?.accountLabel || '';
  $('account').textContent = result?.error || accountLabel || '未取得登入名稱';
};
$('connect').onclick = async () => {
  if (!$('confirmed').checked || !accountLabel || /サインイン|Sign in|登录|登入/i.test(accountLabel)) { show('先讀取登入名稱並確認帳號'); return; }
  const result = await chrome.runtime.sendMessage({ type: 'connect', slot: $('slot').value, token: $('token').value.trim(), accountLabel });
  show(result?.error || '已連接；可關閉這個小視窗');
};
const saved = await chrome.storage.local.get(['prefs', 'status']);
if (saved.prefs?.slot) $('slot').value = saved.prefs.slot;
show(saved.status || '尚未連線');
