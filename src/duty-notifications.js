const TAIPEI_TIME_ZONE = 'Asia/Taipei';

const taipeiPartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TAIPEI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
}

function taipeiParts(date) {
  return Object.fromEntries(
    taipeiPartsFormatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function taipeiDateKey(date = new Date()) {
  const parts = taipeiParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function dutyWindowStatus(date, start, end) {
  const parts = taipeiParts(date);
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);

  if (startMinutes === endMinutes) {
    return { active: true, alwaysActive: true, sessionKey: dateKey };
  }

  if (startMinutes < endMinutes) {
    return {
      active: currentMinutes >= startMinutes && currentMinutes < endMinutes,
      alwaysActive: false,
      sessionKey: dateKey
    };
  }

  const active = currentMinutes >= startMinutes || currentMinutes < endMinutes;
  return {
    active,
    alwaysActive: false,
    sessionKey: currentMinutes >= startMinutes ? dateKey : shiftDateKey(dateKey, -1)
  };
}

export function formatDutyNotification({
  kind,
  label,
  start,
  end,
  now = new Date()
}) {
  const time = now.toLocaleString('zh-TW', { timeZone: TAIPEI_TIME_ZONE });
  if (kind === 'start') {
    return [
      `🟢 ${label}｜今日掃描開始`,
      `監控時段：${start}～${end}`,
      `開始時間：${time}`,
      '系統將依設定頻率自動掃描，有重要情報才會另外推播。'
    ].join('\n');
  }

  return [
    `🌙 ${label}｜今日掃描結束`,
    `本次時段：${start}～${end}`,
    `結束時間：${time}`,
    `下一次將於 ${start} 自動恢復掃描。`
  ].join('\n');
}

export class DailyDutyNotifier {
  constructor({
    id,
    label,
    state,
    getConfig,
    notify,
    save,
    log = () => {}
  }) {
    this.id = id;
    this.label = label;
    this.state = state;
    this.getConfig = getConfig;
    this.notify = notify;
    this.save = save;
    this.log = log;
    this.lastActive = null;
    this.activeSessionKey = null;
    this.running = false;
  }

  records() {
    this.state.dutyNotifications ||= {};
    this.state.dutyNotifications[this.id] ||= {};
    return this.state.dutyNotifications[this.id];
  }

  async send(kind, sessionKey, config, now) {
    const records = this.records();
    const key = kind === 'start' ? 'lastStartedSession' : 'lastEndedSession';
    if (records[key] === sessionKey) return false;

    const message = formatDutyNotification({
      kind,
      label: this.label,
      start: config.activeHours.start,
      end: config.activeHours.end,
      now
    });
    await this.notify(message);
    records[key] = sessionKey;
    records[kind === 'start' ? 'lastStartedAt' : 'lastEndedAt'] = now.toISOString();
    await this.save();
    this.log(`${this.label}${kind === 'start' ? '開始' : '結束'}通知已送出。`);
    return true;
  }

  async check(now = new Date()) {
    if (this.running) return null;
    this.running = true;
    try {
      const config = this.getConfig();
      if (!config.enabled) {
        this.lastActive = false;
        this.activeSessionKey = null;
        return null;
      }

      const status = dutyWindowStatus(
        now,
        config.activeHours.start,
        config.activeHours.end
      );
      const previousActive = this.lastActive;
      const previousSessionKey = this.activeSessionKey;
      this.lastActive = status.active;

      if (status.active) {
        if (
          status.alwaysActive
          && previousActive === true
          && previousSessionKey
          && previousSessionKey !== status.sessionKey
        ) {
          await this.send('end', previousSessionKey, config, now);
        }
        this.activeSessionKey = status.sessionKey;
        const sent = await this.send('start', status.sessionKey, config, now);
        return sent ? 'start' : null;
      }

      this.activeSessionKey = null;
      if (previousActive === true && previousSessionKey) {
        const sent = await this.send('end', previousSessionKey, config, now);
        return sent ? 'end' : null;
      }
      return null;
    } finally {
      this.running = false;
    }
  }
}
