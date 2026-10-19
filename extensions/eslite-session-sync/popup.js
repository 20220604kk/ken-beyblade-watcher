const byId = id => document.getElementById(id);
const current = await chrome.storage.local.get(['slot', 'lastSyncAt', 'lastError']);
byId('slot').value = current.slot || '';
byId('status').textContent = current.lastError || (current.lastSyncAt ? '最後同步：' + new Date(current.lastSyncAt).toLocaleString() : '尚未同步');
byId('save').onclick = async () => {
  const result = await chrome.runtime.sendMessage({ type: 'configure', slot: byId('slot').value.trim().toUpperCase(), token: byId('token').value.trim() });
  byId('token').value = ''; byId('status').textContent = result.error || '已設定；同帳號 API 核對成功才會保存';
};
byId('stop').onclick = async () => { await chrome.storage.local.set({ enabled: false }); byId('status').textContent = '已停止'; };
