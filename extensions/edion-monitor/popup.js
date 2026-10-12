const status = document.querySelector('#status');
async function render() {
  const value = await chrome.storage.local.get(['enabled', 'lastPollAt', 'lastError']);
  status.textContent = (value.enabled ? '連接已開啟' : '已停止') + '｜最近本機連線：' + (value.lastPollAt ? new Date(value.lastPollAt).toLocaleTimeString() : '尚無') + (value.lastError ? '｜' + value.lastError : '');
}
async function send(message) { const result = await chrome.runtime.sendMessage(message); if (result.error) throw new Error(result.error); }
document.querySelector('#connect').onclick = async () => {
  const button = document.querySelector('#connect'); button.disabled = true;
  try { await send({ type: 'connect', token: document.querySelector('#token').value }); document.querySelector('#token').value = ''; await render(); }
  catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
};
document.querySelector('#stop').onclick = async () => { try { await send({ type: 'disconnect' }); await render(); } catch (error) { status.textContent = error.message; } };
document.querySelector('#verify').onclick = async () => { try { await send({ type: 'open-verification' }); } catch (error) { status.textContent = error.message; } };
void render();
