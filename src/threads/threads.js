// Read-only Threads driver on top of a browser page (the AdsPower profile, already logged in).
// It never likes, follows or writes anything: it opens pages, scrolls, and reads the JSON
// the site loads for itself. Element lookups live in SELECTORS so they can be fixed in one place.
import fs from 'node:fs';
import path from 'node:path';
import { harvest, newBag, parseLoose, parseCount, normName } from './extract.js';

export const SELECTORS = {
  followersLink: /\bfollowers?\b|подписчик/i,       // the "12.3K followers" line in a profile header
  followingTab: /\bfollowing\b|подписки/i,          // the tab inside the followers dialog
  dialog: '[role="dialog"]',
  followBtn: /^(follow|follow back|подписаться)$/i,
  followingBtn: /^(following|requested|подписки|вы подписаны)$/i,
  composeOpen: /what['’]s new|start a thread|что нового/i,   // the "What's new?" box on the home feed
  composeBox: '[contenteditable="true"], textarea',
  composeFile: 'input[type="file"]',
  composeSubmit: /^(post|опубликовать)$/i,
  profileLinks: 'a[href^="/@"]',
};

export class Blocked extends Error {}

const rand = (a, b) => a + Math.random() * Math.max(0, b - a);

export class Threads {
  constructor(page, { base, delayMin = 2500, delayMax = 6000, debugDir, check = () => {} } = {}) {
    this.page = page;
    this.base = String(base || 'https://www.threads.com').replace(/\/+$/, '');
    this.delayMin = delayMin;
    this.delayMax = delayMax;
    this.debugDir = debugDir;
    this.check = check;       // throws when the user pressed Stop
    this.bag = newBag();
    this.gen = 0;
    page.on('response', (res) => this.onResponse(res));
  }

  async onResponse(res) {
    const gen = this.gen;
    try {
      if (res.status() !== 200 || !/graphql|\/api\//.test(res.url())) return;
      const text = await res.text();
      if (gen !== this.gen || text.length > 8e6) return;
      for (const doc of parseLoose(text)) harvest(doc, this.bag);
    } catch { /* body unavailable (navigation, redirect) */ }
  }

  async pause(scale = 1) {
    this.check();
    const ms = rand(this.delayMin, this.delayMax) * scale;
    if (ms > 0) await this.page.waitForTimeout(ms);
    this.check();
  }

  async goto(pathname) {
    this.check();
    this.gen++;
    this.bag = newBag();
    await this.page.goto(this.base + pathname, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const url = this.page.url();
    if (/\/(challenge|checkpoint|suspended)/i.test(url)) {
      throw new Blocked('Threads просит подтверждение аккаунта (checkpoint). Парсинг остановлен — откройте профиль в AdsPower и пройдите проверку вручную.');
    }
    if (/\/login/i.test(url)) throw new Blocked('В этом профиле AdsPower не выполнен вход в Threads. Войдите в аккаунт вручную и запустите парсинг снова.');
    await this.readEmbedded();
    await this.pause();
  }

  // Data the page shipped inside <script type="application/json"> tags.
  async readEmbedded() {
    const blobs = await this.page.$$eval('script[type="application/json"]', (els) => els.map((e) => e.textContent || '')).catch(() => []);
    for (const b of blobs) {
      if (b.length < 40 || !b.includes('"username"')) continue;
      for (const doc of parseLoose(b)) harvest(doc, this.bag);
    }
  }

  // Scroll the page (or the element under the pointer) until nothing new arrives.
  async scroll(times, size) {
    let idle = 0;
    for (let i = 0; i < times && idle < 2; i++) {
      const before = size();
      await this.page.mouse.wheel(0, rand(1400, 2200));
      await this.pause(0.5);
      idle = size() > before ? 0 : idle + 1;
    }
  }

  async loggedIn() {
    await this.goto('/');
    return (await this.page.locator('a[href*="/login"]').count()) === 0;
  }

  async profile(username, { scrolls = 3 } = {}) {
    const name = normName(username);
    await this.goto(`/@${name}`);
    await this.scroll(scrolls, () => this.bag.posts.size);
    const known = this.bag.users.get(name);
    const user = { username: name, ...known };
    if (user.followers == null) {
      const text = await this.page.getByText(SELECTORS.followersLink).first().innerText({ timeout: 2000 }).catch(() => '');
      user.followers = parseCount(text);
    }
    const posts = [...this.bag.posts.values()].filter((p) => p.username === name && !p.embedded);
    return { found: Boolean(known) || posts.length > 0 || user.followers != null, user, posts };
  }

  // People who replied under a post: [{ username, text, likes }]
  async replies(author, code, { scrolls = 3 } = {}) {
    const name = normName(author);
    await this.goto(`/@${name}/post/${code}`);
    await this.scroll(scrolls, () => this.bag.posts.size);
    return [...this.bag.posts.values()]
      .filter((p) => p.username !== name && !p.embedded)
      .map((p) => ({ username: p.username, text: p.text, likes: p.likes }));
  }

  // Comments the user left under other people's posts (the "Replies" tab): { list: [{ code, text, to, takenAt, likes, replies }], found, user }
  async comments(username, { scrolls = 3 } = {}) {
    const name = normName(username);
    await this.goto(`/@${name}/replies`);
    await this.scroll(scrolls, () => this.bag.posts.size);
    const out = [];
    for (const [key, p] of this.bag.posts) {
      if (p.username !== name || p.embedded) continue;
      const to = p.replyTo || this.bag.parents.get(key) || null;
      if (!(p.isReply || to) || to === name) continue;
      const parent = this.bag.posts.get(this.bag.parentPosts.get(key));
      out.push({ code: p.code, text: p.text.slice(0, 400), to, takenAt: p.takenAt, likes: p.likes, replies: p.replies, tags: parent?.tags || [] });
    }
    const own = [...this.bag.posts.values()].filter((p) => p.username === name && !p.embedded).length;
    return { list: out, found: this.bag.users.has(name) || own > 0, user: { username: name, ...this.bag.users.get(name) } };
  }

  // Accounts a user follows. Returns { user, following: [username] } or following: null when the list is hidden.
  async following(username, { scrolls = 6 } = {}) {
    const name = normName(username);
    await this.goto(`/@${name}`);
    const user = { username: name, ...this.bag.users.get(name) };
    const page = this.page;
    try {
      await page.getByText(SELECTORS.followersLink).first().click({ timeout: 6000 });
      const dialog = page.locator(SELECTORS.dialog).last();
      await dialog.waitFor({ state: 'visible', timeout: 8000 });
      await dialog.getByText(SELECTORS.followingTab).first().click({ timeout: 6000 });
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      await this.pause(0.5);
      const names = new Set();
      const read = async () => {
        const hrefs = await dialog.locator(SELECTORS.profileLinks).evaluateAll((els) => els
          .filter((e) => e.getClientRects().length > 0)
          .map((e) => e.getAttribute('href') || ''));
        for (const h of hrefs) {
          const n = h.replace(/^\/@/, '').split(/[/?#]/)[0].toLowerCase();
          if (n && n !== name) names.add(n);
        }
        return names.size;
      };
      await read();
      const box = await dialog.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
      let idle = 0;
      for (let i = 0; i < scrolls && idle < 2; i++) {
        const before = names.size;
        await page.mouse.wheel(0, rand(1200, 1900));
        await this.pause(0.4);
        idle = (await read()) > before ? 0 : idle + 1;
      }
      const users = this.bag.users;
      await page.keyboard.press('Escape').catch(() => {});
      return { user, following: [...names], users };
    } catch (e) {
      if (e instanceof Blocked || e.name === 'Stop') throw e;
      await this.dump(`following-${name}`);
      await page.keyboard.press('Escape').catch(() => {});
      return { user, following: null, users: this.bag.users, error: e.message.split('\n')[0] };
    }
  }

  // Authors of posts found by a keyword search: [username]
  async search(query, { scrolls = 3 } = {}) {
    await this.goto(`/search?q=${encodeURIComponent(query)}&serp_type=default`);
    await this.scroll(scrolls, () => this.bag.posts.size);
    const authors = new Set([...this.bag.posts.values()].filter((p) => !p.embedded).map((p) => p.username));
    return { authors: [...authors], users: this.bag.users };
  }

  // Posts filed under a category (topic). Falls back to plain search when the topic page gives nothing.
  async topic(name, { scrolls = 8, tagPath = '/search?q={q}&serp_type=tags' } = {}) {
    for (const tpl of [tagPath, '/search?q={q}&serp_type=default']) {
      await this.goto(tpl.replace('{q}', encodeURIComponent(name)));
      await this.scroll(scrolls, () => this.bag.posts.size);
      const posts = [...this.bag.posts.values()].filter((p) => !p.embedded && !p.isReply);
      if (posts.length) return posts;
    }
    return [];
  }

  // Posts currently shown in a feed page (for example the Following feed).
  async feed(pathname) {
    await this.goto(pathname);
    return [...this.bag.posts.values()].filter((p) => !p.embedded && !p.isReply);
  }

  // Follow an account from the logged-in profile. Returns 'followed' or 'already'.
  async follow(username) {
    const name = normName(username);
    await this.goto(`/@${name}`);
    const page = this.page;
    const done = page.getByRole('button', { name: SELECTORS.followingBtn }).first();
    const btn = page.getByRole('button', { name: SELECTORS.followBtn }).first();
    if ((await btn.count()) === 0) {
      if (await done.count()) return 'already';
      await this.dump(`follow-${name}`);
      throw new Error('кнопка «Follow» не найдена');
    }
    await btn.click({ timeout: 6000 });
    await done.waitFor({ state: 'visible', timeout: 10000 });
    return 'followed';
  }

  // Publish one post from the logged-in account. Throws unless the composer closed after "Post".
  async post(text, imagePath) {
    const page = this.page;
    await this.goto('/');
    try {
      await page.getByText(SELECTORS.composeOpen).first().click({ timeout: 8000 });
      const dialog = page.locator(SELECTORS.dialog).last();
      await dialog.waitFor({ state: 'visible', timeout: 8000 });
      const box = dialog.locator(SELECTORS.composeBox).first();
      await box.click({ timeout: 6000 });
      await page.keyboard.insertText(text);
      if (imagePath) {
        await dialog.locator(SELECTORS.composeFile).first().setInputFiles(imagePath, { timeout: 8000 });
        await page.waitForTimeout(3000);   // let the preview and upload settle
      }
      await this.pause(0.5);
      const typed = await box.evaluate((el) => el.value ?? el.innerText);
      if (!String(typed).includes(text.slice(0, 20))) throw new Error('текст не попал в поле ввода');
      await dialog.getByRole('button', { name: SELECTORS.composeSubmit }).last().click({ timeout: 8000 });
      await dialog.waitFor({ state: 'hidden', timeout: 30000 });
    } catch (e) {
      if (e instanceof Blocked) throw e;
      await this.dump('post');
      throw new Error(`Не удалось опубликовать пост: ${e.message.split('\n')[0]}. Проверьте в Threads, не появился ли он, прежде чем повторять.`);
    }
  }

  // Download an avatar through the profile's browser (so it uses the profile's proxy).
  async avatar(url) {
    if (!url) return null;
    const b64 = await this.page.evaluate(async (u) => {
      try {
        const r = await fetch(u);
        if (!r.ok) return null;
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length > 2e6) return null;
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        return btoa(s);
      } catch { return null; }
    }, url).catch(() => null);
    return b64 ? Buffer.from(b64, 'base64') : null;
  }

  // Keep a screenshot and the page HTML when something on screen was not as expected.
  async dump(label) {
    if (!this.debugDir) return;
    try {
      fs.mkdirSync(this.debugDir, { recursive: true });
      const old = fs.readdirSync(this.debugDir).sort();
      for (const f of old.slice(0, Math.max(0, old.length - 38))) fs.rmSync(path.join(this.debugDir, f), { force: true });
      const stem = path.join(this.debugDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${label.replace(/[^\w.-]+/g, '_')}`);
      await this.page.screenshot({ path: `${stem}.png` });
      fs.writeFileSync(`${stem}.html`, await this.page.content());
    } catch { /* debugging aid only */ }
  }
}
