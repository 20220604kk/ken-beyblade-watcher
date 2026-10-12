# Manual browser handoff only. No scan loop, notification or order functionality.
param(
    [ValidateSet('Open', 'Inspect', 'Close')]
    [string]$Action = 'Inspect'
)
$ErrorActionPreference = 'Stop'
$browserCli = Join-Path $env:APPDATA 'npm\node_modules\agent-browser\bin\agent-browser-win32-x64.exe'
$browserProfile = Join-Path $env:LOCALAPPDATA 'ShoppingWebsiteWatcher\shopee-funbox-profile'
$browserSession = 'shopee-funbox-persistent'
if (-not (Test-Path -LiteralPath $browserCli)) {
    throw 'agent-browser executable not found. No browser was started.'
}

if ($Action -eq 'Open') {
    $result = & $browserCli --session $browserSession --profile $browserProfile --headed open 'https://shopee.tw/mall/search?keyword=beyblade&shop=285705541' 2>&1
} elseif ($Action -eq 'Close') {
    $result = & $browserCli --session $browserSession close 2>&1
} else {
    # Inspect must not auto-launch a temporary browser that loses the intended profile.
    $sessionOutput = (& $browserCli session list --json 2>&1) -join "`n"
    if ($sessionOutput -notmatch [regex]::Escape($browserSession)) {
        throw 'Dedicated browser is not running. Run with -Action Open first.'
    }
    $script = @'
JSON.stringify((() => {
  const path = location.pathname;
  const body = document.body?.innerText || '';
  const buttons = [...document.querySelectorAll('button')];
  const blocked = /^\/verify(?:\/|$)/.test(path) || /驗證目前無法完成|頁面無法顯示/.test(body);
  const loginRequired = /^\/(?:buyer\/)?login(?:\/|$)/.test(path) || !!document.querySelector('input[type=password]');
  const ids = new Set();
  if (!blocked && !loginRequired && location.hostname === 'shopee.tw') {
    for (const anchor of document.querySelectorAll('a[href]')) {
      try {
        const u = new URL(anchor.href);
        if (u.hostname !== 'shopee.tw' || u.protocol !== 'https:') continue;
        const m = u.pathname.match(/^\/product\/285705541\/([1-9]\d*)\/?$/)
          || u.pathname.match(/-i\.285705541\.([1-9]\d*)\/?$/);
        if (m) ids.add(m[1]);
      } catch {}
    }
  }
  return {
    origin: location.origin,
    path,
    health: blocked ? 'blocked' : loginRequired ? 'auth-required' : ids.size ? 'candidate-links-only' : 'no-product-evidence',
    retryButtonPresent: buttons.some(b => /再試一次/.test(b.innerText)),
    expectedShopId: '285705541',
    candidateItemIds: [...ids],
    liveInventoryVerified: false,
    productionMonitoringEnabled: false,
    note: 'Product links alone do not prove inventory, full coverage, or a successful login.'
  };
})())
'@
    $result = & $browserCli --session $browserSession eval $script 2>&1
}
$exitCode = $LASTEXITCODE
# Strip opaque verification/session/tracking queries from console output.
$result | ForEach-Object {
    [regex]::Replace([string]$_, 'https://shopee\.tw/verify/[^\s"'']+', { param($m) ($m.Value -split '\?')[0] })
}
if ($exitCode -ne 0) { exit $exitCode }
