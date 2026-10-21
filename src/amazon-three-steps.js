const orderNumber = /^\d{3}-\d{7}-\d{7}$/;
const pages = { '01': '商品頁面', '02': '安全結帳', '03': '取得訂單' };

// Chronological events with three categories, never a fixed three-row summary.
export function amazonThreeSteps(events = []) {
  const rows = [];
  let stage = '01';
  let bought = false, submitted = false;
  for (const event of events) {
    if (pages[event.step] && event.page === pages[event.step] && event.action) {
      stage = event.step;
      if (event.action === '讀取商品') { bought = false; submitted = false; }
      if (event.action === '發現直接購買') bought = true;
      if (event.action === '送出訂單') submitted = true;
      rows.push({ step: stage, page: pages[stage], action: event.action, status: event.status,
        at: event.at, elapsedMs: event.elapsedMs,
        ...(event.orderId && orderNumber.test(event.orderId) ? { orderId: event.orderId } : {}) });
      continue;
    }
    let action, status;
    switch (event.name) {
      case 'refresh_start': stage = '01'; bought = false; submitted = false; action = '讀取商品'; status = '檢查中'; break;
      case 'product_evaluated':
        stage = '01'; action = event.result === 'qualified' ? '符合購買條件' : '等待可購商品'; status = event.result === 'qualified' ? '成功' : '等待'; break;
      case 'buy_now_click': stage = '01'; bought = true; action = '發現直接購買'; status = '成功'; break;
      case 'add_to_cart': stage = '01'; bought = true; action = 'AOD 自營單品加車'; status = '執行中'; break;
      case 'checkout_prime_decline': stage = '02'; action = '拒絕 Prime 試用，接續結帳'; status = '執行中'; break;
      case 'checkout_render': stage = '02'; action = '接續官方結帳頁'; status = '檢查中'; break;
      case 'checkout_item_continue': stage = '02'; action = '核對單品數量後續行'; status = '執行中'; break;
      case 'pre_submit_retry': stage = '02'; submitted = false; action = `尚未送單，${Math.ceil((event.retryDelayMs || 0) / 1000)}秒後重試（連續失敗${event.retryCount || 1}次）`; status = '等待'; break;
      case 'api_add_cart': case 'add_cart_click': stage = '01'; action = '舊加車流程，非直接購買'; status = '執行中'; break;
      case 'api_cart_resume': stage = '01'; action = '舊購物車待核對'; status = '待核對'; break;
      case 'api_cart_empty':
        if (event.result !== 'manual_cart_reviewed') continue;
        stage = '01'; action = '確認舊購物車為空'; status = '完成'; break;
      case 'api_checkout_entry': case 'proceed_checkout': case 'checkout_inspect': case 'checkout_continue':
        stage = '02'; action = '讀取安全結帳'; status = '檢查中'; break;
      case 'checkout_browser_entry': stage = '02'; action = '啟用背景瀏覽器結帳入口'; status = '執行中'; break;
      case 'checkout_stock_wait': stage = '02'; action = '紅字頁等回流，250ms 循序重查（不重加／不送數量0）'; status = '等待'; break;
      case 'checkout_cart_empty': stage = '02'; action = '購物車已空，回商品頁等新報價'; status = '等待'; break;
      case 'checkout_verified': stage = '02'; action = '發現購買按鈕'; status = '成功'; break;
      case 'submit_order': stage = '02'; submitted = true; action = '送出訂單'; status = '執行中'; break;
      case 'api_order_check': stage = '03'; action = '查詢正式訂單'; status = '檢查中'; break;
      case 'api_submit_unknown': stage = '03'; action = '送單回應待核對'; status = '待核對'; break;
      case 'submit_result':
        stage = '03'; status = event.status === 'ordered' && orderNumber.test(event.orderId || '') ? '成功' : '待核對';
        action = status === '成功' ? '取得訂單編號' : '尚未確認訂單'; break;
      case 'failure': {
        if (submitted) stage = '03';
        else if (bought) stage = '02';
        const error = String(event.error || '');
        action = submitted ? '送單結果待核對' : /沒有可用的立即購買按鈕/.test(error) ? '直購按鈕已消失，繼續等補貨'
          : /結帳入口回傳 HTTP 404/.test(error) ? '結帳入口不存在（HTTP 404）'
          : /安全結帳只收到空白頁框/.test(error) ? '結帳頁空白，下一輪切換瀏覽器入口'
          : /購物車已空/.test(error) ? '購物車已空，回商品頁等新報價'
          : /結帳時庫存不足/.test(error) ? '結帳時庫存已不足，繼續等補貨' : /登入/.test(error) ? '此流程需核對登入'
          : /驗證/.test(error) ? '需要人工驗證' : /限流|429|503|降速/.test(error) ? '官網暫時限流'
            : /逾時|回應不明|連線/.test(error) ? '官網回應未確認' : '本輪失敗';
        status = submitted ? '待核對' : '失敗'; break;
      }
      default: continue;
    }
    rows.push({ step: stage, page: pages[stage], action, status, at: event.at, elapsedMs: event.elapsedMs,
      ...(stage === '03' && status === '成功' ? { orderId: event.orderId } : {}) });
  }
  return rows;
}
