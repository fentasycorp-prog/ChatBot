// Minimal client for the AdsPower Local API (the app must be running on this computer).
// Docs: https://localapi-doc-en.adspower.com/ — the API allows about one request per second.

let last = 0;
async function throttle() {
  const wait = last + 1100 - Date.now();
  last = Math.max(Date.now(), last + 1100);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export class AdsPower {
  constructor(baseUrl, apiKey) {
    this.base = String(baseUrl || 'http://local.adspower.net:50325').replace(/\/+$/, '');
    this.key = apiKey || process.env.ADSPOWER_API_KEY || '';
  }

  async call(pathname, params = {}) {
    await throttle();
    const url = new URL(this.base + pathname);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url, { headers: this.key ? { Authorization: `Bearer ${this.key}` } : {}, signal: AbortSignal.timeout(60000) });
    } catch (e) {
      throw new Error(`AdsPower не отвечает по адресу ${this.base}. Откройте приложение AdsPower и проверьте адрес API (${e.cause?.code || e.message})`);
    }
    const data = await res.json().catch(() => null);
    if (!data) throw new Error(`AdsPower вернул непонятный ответ (HTTP ${res.status})`);
    if (data.code !== 0) throw new Error(`AdsPower: ${data.msg || 'ошибка'}${/api.?key|auth/i.test(data.msg || '') ? ' — проверьте API-ключ' : ''}`);
    return data.data ?? {};
  }

  status() { return this.call('/status'); }

  async profiles() {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const d = await this.call('/api/v1/user/list', { page, page_size: 100 });
      const list = d.list || [];
      for (const p of list) out.push({ id: p.user_id, name: p.name || '', serial: p.serial_number || '', group: p.group_name || '' });
      if (list.length < 100) break;
    }
    return out;
  }

  // Returns the DevTools address of the profile's browser; reuses a browser that is already open.
  async open(profileId) {
    if (!profileId) throw new Error('Не выбран профиль AdsPower');
    const active = await this.call('/api/v1/browser/active', { user_id: profileId }).catch(() => null);
    if (active?.status === 'Active' && active.ws?.puppeteer) return { ws: active.ws.puppeteer, started: false };
    const d = await this.call('/api/v1/browser/start', { user_id: profileId, open_tabs: 1 });
    if (!d.ws?.puppeteer) throw new Error('AdsPower запустил профиль, но не вернул адрес браузера');
    return { ws: d.ws.puppeteer, started: true };
  }

  stop(profileId) { return this.call('/api/v1/browser/stop', { user_id: profileId }); }
}
