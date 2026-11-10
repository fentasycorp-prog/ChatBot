#!/usr/bin/env node
// Web editor backend: static UI, JSON API over the same ops as the MCP server,
// media streaming with Range support, and SSE so the UI follows the agent live.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { HOME, load, projDir, newId } from './store.js';
import { opByName } from './ops.js';

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';
const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');
const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const clients = new Set();
const broadcast = (event, data) => { for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

fs.mkdirSync(HOME, { recursive: true });
let timer;
fs.watch(HOME, { recursive: true }, (_e, file) => {
  if (!file || !String(file).endsWith('project.json')) return;
  clearTimeout(timer);
  timer = setTimeout(() => broadcast('change', {}), 80);
});

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 2e6) throw new Error('Слишком большой запрос'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function sendFile(req, res, file, download) {
  if (!fs.existsSync(file)) return json(res, 404, { error: 'Файл не найден' });
  const { size } = fs.statSync(file);
  const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
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
    // POST /api/op/<name> — run any editing operation as the user.
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'op' && opByName[seg[2]]) {
      const args = await body(req);
      const ctx = { actor: 'user', onProgress: (f) => broadcast('progress', { projectId: args.projectId, fraction: f }) };
      const { log: _log, ...result } = await opByName[seg[2]].run(args, ctx).then((r) => (Array.isArray(r) ? { list: r } : r));
      return json(res, 200, result);
    }
    // GET /api/activity/<projectId>
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'activity') {
      return json(res, 200, load(seg[2]).activity.slice(-60));
    }
    // POST /api/upload/<projectId>?name=file.mp4 — raw file body.
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'upload') {
      load(seg[2]);
      const name = path.basename(url.searchParams.get('name') || 'upload').replace(/[^\p{L}\p{N}._-]+/gu, '_');
      const file = path.join(projDir(seg[2]), 'media', `${newId('up')}_${name}`);
      await pipeline(req, fs.createWriteStream(file));
      try {
        return json(res, 200, await opByName.import_media.run({ projectId: seg[2], source: file, name }, { actor: 'user' }));
      } catch (e) { fs.rmSync(file, { force: true }); throw e; }
    }
    // GET /media/<projectId>/<mediaId>, /thumb/<projectId>/<file>, /export/<projectId>/<file>
    if (req.method === 'GET' && seg[0] === 'media') {
      const m = load(seg[1]).media.find((x) => x.id === seg[2]);
      return m ? sendFile(req, res, m.path) : json(res, 404, { error: 'Файл не найден' });
    }
    if (req.method === 'GET' && (seg[0] === 'thumb' || seg[0] === 'export')) {
      const dir = path.join(projDir(seg[1]), seg[0] === 'thumb' ? 'thumbs' : 'exports');
      return sendFile(req, res, path.join(dir, path.basename(seg[2] || '')), seg[0] === 'export' && url.searchParams.has('dl'));
    }
    json(res, 404, { error: 'Не найдено' });
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`Видеостудия: http://${HOST}:${PORT}  (проекты: ${HOME})`));
