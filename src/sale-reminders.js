export const SALE_REMINDER_MINUTES = [60, 30, 10];

function formatTaipei(value, options) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour12: false,
    ...options
  }).format(new Date(value)).replace(/\s+/g, ' ');
}

export function formatSaleTime(value) {
  return formatTaipei(value, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatCurrentTime(value) {
  return formatTaipei(value, { hour: '2-digit', minute: '2-digit' });
}

export function saleReminderListedNotification(reminder, now = new Date()) {
  const siteName = reminder.siteName || '購物網站';
  const saleTime = formatSaleTime(reminder.saleStartAt);
  const title = reminder.name || '戰鬥陀螺商品';
  const priceLine = reminder.price ? `\n**價格：** ${reminder.price}` : '';
  const embed = {
    author: { name: '陀螺通知監控儀表・商品開賣情報' },
    title: `🛒 ${siteName}｜${title}`,
    url: reminder.url,
    color: 0x7c5cff,
    description: [
      `**購物網站：** ${siteName}`,
      `**商品：** ${title}`,
      `**開賣時間：** ${saleTime}${priceLine}`,
      '',
      `**🛒 商品頁：** [立即前往](${reminder.url})`
    ].join('\n'),
    footer: { text: '後續將於開賣前 60／30／10 分鐘再次提醒' },
    timestamp: new Date(now).toISOString()
  };
  if (reminder.imageUrl) embed.thumbnail = { url: reminder.imageUrl };
  return {
    text: [
      `🛒 ${siteName} 商品開賣情報`,
      `商品：${title}`,
      `${saleTime} 開賣`,
      reminder.url
    ].join('\n'),
    options: {
      discordPreview: `🛒 商品開賣｜${siteName}｜${title}\n${saleTime} 開賣`,
      embeds: [embed]
    }
  };
}

export function saleReminderNotification(reminder, remainingMinutes, now = new Date()) {
  const siteName = reminder.siteName || '購物網站';
  const saleTime = formatSaleTime(reminder.saleStartAt);
  const currentTime = formatCurrentTime(now);
  const title = reminder.name || '戰鬥陀螺商品';
  const text = [
    `購物網站：${siteName}`,
    `商品：${title}`,
    `${saleTime} 開賣`,
    `現在時間 ${currentTime}，距離開賣 ${remainingMinutes} 分鐘`,
    reminder.url
  ].join('\n');
  return {
    text,
    options: {
      discordPreview: `⏰ ${siteName}｜${title} 距離開賣 ${remainingMinutes} 分鐘\n${saleTime} 開賣`,
      embeds: [{
        author: { name: '陀螺通知監控儀表・開賣倒數' },
        title: `⏰ 距離開賣 ${remainingMinutes} 分鐘｜${title}`,
        url: reminder.url,
        color: remainingMinutes <= 10 ? 0xe5484d : remainingMinutes <= 30 ? 0xf59e0b : 0x3c82f6,
        description: [
          `**購物網站：** ${siteName}`,
          `**商品：** ${title}`,
          `**開賣時間：** ${saleTime}`,
          `**現在時間：** ${currentTime}`,
          `**剩餘時間：** ${remainingMinutes} 分鐘`,
          '',
          `**🛒 商品頁：** [立即前往](${reminder.url})`
        ].join('\n'),
        footer: { text: '固定於開賣前 60／30／10 分鐘提醒' },
        timestamp: new Date(now).toISOString()
      }]
    }
  };
}

export class SaleReminderMonitor {
  constructor({ state, getReminders, notify, log = () => {}, now = () => new Date() }) {
    this.state = state;
    this.getReminders = getReminders;
    this.notify = notify;
    this.log = log;
    this.now = now;
    this.running = false;
  }

  async check() {
    if (this.running) return { skipped: true };
    this.running = true;
    const current = this.now();
    const summary = { checkedAt: current.toISOString(), checked: 0, notified: 0, expired: 0, errors: [] };
    let changed = false;
    try {
      this.state.data.commerce ||= {};
      this.state.data.commerce.saleReminders ||= {};
      const storage = this.state.data.commerce.saleReminders;
      const configuredIds = new Set();
      for (const reminder of this.getReminders()) {
        configuredIds.add(reminder.id);
        if (reminder.enabled === false) continue;
        summary.checked += 1;
        const saleStart = new Date(reminder.saleStartAt);
        if (!Number.isFinite(saleStart.getTime())) {
          summary.errors.push(`${reminder.name}：開賣時間格式錯誤`);
          continue;
        }
        const record = storage[reminder.id] || { handledMinutes: [] };
        record.handledMinutes ||= [];
        record.lastCheckedAt = current.toISOString();
        storage[reminder.id] = record;
        changed = true;
        const remainingMs = saleStart.getTime() - current.getTime();
        if (remainingMs <= 0) {
          if (!record.expiredAt) {
            record.expiredAt = current.toISOString();
            summary.expired += 1;
          }
          continue;
        }
        const eligible = SALE_REMINDER_MINUTES.filter((minutes) =>
          !record.handledMinutes.includes(minutes) && remainingMs <= minutes * 60_000
        );
        if (!eligible.length) continue;
        const threshold = Math.min(...eligible);
        const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
        try {
          const message = saleReminderNotification(reminder, remainingMinutes, current);
          await this.notify(message.text, message.options);
          record.handledMinutes = SALE_REMINDER_MINUTES.filter((minutes) =>
            minutes >= threshold || record.handledMinutes.includes(minutes)
          );
          record.lastNotifiedAt = current.toISOString();
          record.lastNotifiedMinutes = remainingMinutes;
          summary.notified += 1;
          this.log(`${reminder.siteName}｜${reminder.name}：已送出開賣前 ${remainingMinutes} 分鐘提醒。`);
        } catch (error) {
          summary.errors.push(`${reminder.name}：${error.message}`);
        }
      }
      for (const id of Object.keys(storage)) {
        if (!configuredIds.has(id)) {
          delete storage[id];
          changed = true;
        }
      }
      if (changed) await this.state.save();
      return summary;
    } finally {
      this.running = false;
    }
  }
}
