#!/usr/bin/env node
// Threads parser panel: http://127.0.0.1:4330 — references, settings, the "Парсинг" button, results.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, save, cleanSettings, AVATARS, DIR } from './db.js';
import { AdsPower } from './adspower.js';
import os from 'node:os';
import { crawl, monitor, followBase, publish, Stop, tracked, scouts } from './crawler.js';
import { tgSend } from './telegram.js';
import { normName } from './extract.js';

const PORT = Number(process.env.THREADS_PORT || 4330);
const HOST = '127.0.0.1';
const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'threads.html');

const clients = new Set();
const job = { running: false, stop: false, phase: '', done: 0, total: 0, log: [] };
function emit(event, data) {
  if (event === 'log') { job.log.push(data); if (job.log.length > 400) job.log.splice(0, job.log.length - 400); }
  if (event === 'progress') Object.assign(job, data);
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function start(mode = 'full') {
  if (job.running) throw new Error('Сейчас уже идёт работа — дождитесь окончания или нажмите «Стоп»');
  Object.assign(job, { running: true, stop: false, phase: 'Запуск', done: 0, total: 0, log: [] });
  emit('status', { running: true });
  const run = { monitor, follow: followBase }[mode] || crawl;
  run({ emit, isStopped: () => job.stop, mode })
    .catch((e) => emit('log', { t: new Date().toISOString(), level: e instanceof Stop ? 'info' : 'error', msg: e instanceof Stop ? 'Остановлено пользователем' : e.message.split('\n')[0] }))
    .finally(() => { job.running = false; job.phase = ''; emit('status', { running: false }); });
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function body(req) {
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new Error('Ожидается JSON');
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 14e6) throw new Error('Слишком большой запрос'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function state() {
  const db = load();
  const { adsKey, tgToken, ...settings } = db.settings;
  return {
    settings: { ...settings, hasKey: Boolean(adsKey), hasTg: Boolean(tgToken) },
    seeds: db.seeds,
    accounts: Object.values(db.accounts).map(({ comments, posts, ...a }) => a),
    scouts: scouts(db),
    // Own posts of references and approved authors, newest first.
    newPosts: Object.values(db.accounts).flatMap((a) => (a.posts || []).map((p) => ({ ...p, by: a.username })))
      .sort((x, y) => (y.takenAt || 0) - (x.takenAt || 0)).slice(0, 120)
      .map((p) => ({ ...p, fresh: Boolean(db.lastRun && p.seenAt && Date.parse(db.lastRun.at) - Date.parse(p.seenAt) < 3600e3) })),
    tracked: tracked(db),
    // Latest comments of tracked authors, newest first.
    feed: Object.values(db.accounts).flatMap((a) => (a.comments || []).map((c) => ({ ...c, by: a.username })))
      .sort((x, y) => (y.takenAt || 0) - (x.takenAt || 0)).slice(0, 300)
      .map((c) => ({ ...c, scout: db.accounts[c.by]?.role === 'scout', fresh: Boolean(db.lastRun && c.seenAt && Date.parse(db.lastRun.at) - Date.parse(c.seenAt) < 3600e3) })),
    audienceScanned: Object.values(db.audience).filter((a) => !a.hidden).length,
    lastRun: db.lastRun,
    posts: (db.posts || []).slice(0, 20),
    job: { running: job.running, phase: job.phase, done: job.done, total: job.total, log: job.log.slice(-200) },
    dataDir: DIR,
  };
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // keep spreadsheets from running a bio as a formula
  return `"${s.replace(/"/g, '""')}"`;
};

function csv(db) {
  const rows = [['username', 'url', 'name', 'status', 'score', 'followers', 'posts_per_week', 'avg_likes', 'avg_replies', 'engagement_%', 'overlap', 'last_post', 'posts_30d', 'post_interval_h', 'active_hours_utc', 'scout_comments', 'comments_per_day', 'repeated_comments_%', 'comments_at', 'funnel', 'links', 'bio']];
  for (const a of Object.values(db.accounts).sort((x, y) => (y.score || 0) - (x.score || 0))) {
    if (a.status === 'filtered' || a.status === 'rejected' || a.role === 'scout') continue;
    const m = a.metrics || {};
    rows.push([a.username, `${db.settings.threadsBase}/@${a.username}`, a.fullName, a.role === 'seed' ? 'reference' : a.status, a.score, a.followers,
      m.postsPerWeek, m.avgLikes, m.avgReplies, m.engagementRate, a.overlap ?? '', m.lastPostAt ? new Date(m.lastPostAt * 1000).toISOString().slice(0, 10) : '',
      m.posts30d ?? '', m.avgIntervalH ?? '', (m.activeHours || []).join(' '), a.scoutComments ?? '',
      a.commentStats?.perDay ?? '', a.commentStats?.templated ?? '', (a.commentStats?.targets || []).map((x) => `${x.to}:${x.count}`).join(' '),
      (a.funnel || []).join(' > '), (a.links || []).join(' '), a.bio]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    // Only this computer may talk to the panel (also stops other sites from poking it).
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: 'Доступ только с этого компьютера' });
    const db = load();
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(UI).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      return req.on('close', () => clients.delete(res));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());
    if (req.method === 'GET' && url.pathname === '/api/export.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="threads-accounts.csv"' });
      return res.end(csv(db));
    }
    if (req.method === 'GET' && seg[0] === 'avatar') {
      const file = path.join(AVATARS, path.basename(seg[1] || ''));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method !== 'POST') return json(res, 404, { error: 'Не найдено' });
    const args = await body(req);

    if (url.pathname === '/api/settings') {
      const next = { ...args };
      if (!next.adsKey) delete next.adsKey;       // an empty field keeps the saved key
      if (!next.tgToken) delete next.tgToken;
      db.settings = cleanSettings(next, db.settings);
      save();
      return json(res, 200, state());
    }
    if (url.pathname === '/api/adspower/profiles') {
      const ads = new AdsPower(db.settings.adsUrl, db.settings.adsKey);
      await ads.status();
      return json(res, 200, { profiles: await ads.profiles() });
    }
    if (url.pathname === '/api/seeds' && args.kind === 'scout') {
      for (const raw of args.add || []) {
        const u = normName(raw);
        if (!/^[a-z0-9_.]{1,30}$/.test(u) || db.seeds.includes(u)) continue;
        db.accounts[u] = { foundAt: new Date().toISOString(), ...db.accounts[u], username: u, role: 'scout', status: 'scout', dead: false, misses: 0 };
      }
      for (const raw of args.remove || []) { const u = normName(raw); if (db.accounts[u]?.role === 'scout') delete db.accounts[u]; }
      save();
      return json(res, 200, state());
    }
    if (url.pathname === '/api/seeds') {
      for (const raw of args.add || []) {
        const u = normName(raw);
        if (!/^[a-z0-9_.]{1,30}$/.test(u)) continue;
        if (!db.seeds.includes(u)) db.seeds.push(u);
        if (db.accounts[u]) db.accounts[u].role = 'seed';
      }
      for (const raw of args.remove || []) {
        const u = normName(raw);
        db.seeds = db.seeds.filter((x) => x !== u);
        if (db.accounts[u]) { db.accounts[u].role = 'candidate'; if (db.accounts[u].status === 'new') db.accounts[u].status = 'approved'; }
      }
      save();
      return json(res, 200, state());
    }
    if (seg[0] === 'api' && seg[1] === 'account') {
      const acc = db.accounts[normName(seg[2])];
      if (!acc) return json(res, 404, { error: 'Аккаунт не найден' });
      if (['new', 'approved', 'rejected'].includes(args.status)) acc.status = args.status;
      save();
      return json(res, 200, state());
    }
    if (url.pathname === '/api/run') { start(['watch', 'monitor', 'follow'].includes(args.mode) ? args.mode : 'full'); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/tg-test') {
      if (!(await tgSend(db.settings, '✅ Парсер Threads: сигналы о новых постах будут приходить сюда'))) throw new Error('Укажите токен бота и chat id');
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/approve-all') {
      for (const a of Object.values(db.accounts)) if (a.role === 'candidate' && a.status === 'new') a.status = 'approved';
      save();
      return json(res, 200, state());
    }
    if (url.pathname === '/api/post') {
      const text = String(args.text || '').trim();
      if (!text) throw new Error('Напишите текст поста');
      if ([...text].length > 500) throw new Error('В Threads пост не длиннее 500 символов');
      if (!db.settings.adsProfile) throw new Error('Выберите профиль AdsPower');
      if (job.running) throw new Error('Сейчас идёт парсинг — дождитесь окончания или нажмите «Стоп»');
      let image = null;
      const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(args.image || '');
      if (args.image && !m) throw new Error('Картинка должна быть PNG, JPG или WebP');
      if (m) {
        image = path.join(os.tmpdir(), `threads-post-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
        fs.writeFileSync(image, Buffer.from(m[2], 'base64'));
      }
      Object.assign(job, { running: true, stop: false, phase: 'Публикация', done: 0, total: 0, log: [] });
      emit('status', { running: true });
      publish({ emit, text, image })
        .catch((e) => emit('log', { t: new Date().toISOString(), level: 'error', msg: e.message.split('\n')[0] }))
        .finally(() => { if (image) fs.rmSync(image, { force: true }); job.running = false; job.phase = ''; emit('status', { running: false }); });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/stop') { job.stop = true; return json(res, 200, { ok: true }); }
    json(res, 404, { error: 'Не найдено' });
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
    else res.end();
  }
});

// Scheduled refresh of tracked authors (AdsPower must be running).
setInterval(() => {
  const db = load();
  const h = db.settings.autoHours;
  if (!h || job.running || !db.settings.adsProfile || !(tracked(db).length + scouts(db).length)) return;
  if (db.lastWatchAt && Date.now() - Date.parse(db.lastWatchAt) < h * 3600e3) return;
  db.lastWatchAt = new Date().toISOString();   // a failed attempt waits for the next slot instead of retrying every minute
  save();
  start('watch');
}, 60000).unref();

server.listen(PORT, HOST, () => console.log(`Парсер Threads: http://${HOST}:${PORT}  (данные: ${DIR})`));
