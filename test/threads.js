// Threads parser test: unit checks for the data helpers, then a full run of the real
// server against a fake AdsPower API and a fake Threads site, driven through a real Chromium.
// The fake site imitates the shapes the parser relies on; it does not prove the live site matches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { harvest, newBag, parseCount, parseLoose, isEnglish, metrics, normName, femaleNameHint } from '../src/threads/extract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Math.floor(Date.now() / 1000);
const H = 3600;

// ---------- unit ----------
assert.equal(parseCount('12.3K followers'), 12300);
assert.equal(parseCount('1,204 followers'), 1204);
assert.equal(parseCount('1.2M followers'), 1200000);
assert.equal(parseCount('2,5 тыс. подписчиков'), 2500);
assert.equal(parseCount('845 followers'), 845);
assert.equal(parseCount('12 members'), 12);
assert.equal(normName('https://www.threads.com/@Lola.Luvgood?hl=en'), 'lola.luvgood');
assert.equal(normName(' @skye '), 'skye');
assert.equal(isEnglish('this is so cute, I love what you are doing with it'), true);
assert.equal(isEnglish('какая красивая фотография, очень нравится'), false);
assert.equal(isEnglish('🔥🔥'), null);
assert.equal(femaleNameHint('Lisa Thompson', 'x'), true);
assert.equal(femaleNameHint('', 'mark5754walker'), false);
assert.deepEqual(parseLoose('for (;;);{"a":1}'), [{ a: 1 }]);
assert.equal(parseLoose('{"a":1}\n{"b":2}').length, 2);
{
  const bag = harvest({ data: { edges: [{ node: { thread_items: [{ post: {
    pk: '1', code: 'AAA', user: { pk: '9', username: 'Skye', full_name: 'Skye C', profile_pic_url: 'u' }, caption: { text: 'hi' }, like_count: 10, taken_at: NOW,
    text_post_app_info: { direct_reply_count: 4, share_info: { quoted_post: { pk: '2', code: 'QQQ', user: { pk: '8', username: 'other' }, like_count: 1 } } },
  } }] } }] } }, newBag());
  assert.equal(bag.posts.get('AAA').replies, 4);
  assert.equal(bag.posts.get('AAA').embedded, false);
  assert.equal(bag.posts.get('QQQ').embedded, true);
  assert.ok(bag.users.has('skye') && bag.users.has('other'));
  const m = metrics([...Array(8)].map((_, i) => ({ takenAt: NOW - i * 12 * H, likes: 100, replies: 20, text: 'what do you think of this one', isReply: false })), 10000);
  assert.ok(m.postsPerWeek > 10 && m.avgReplies === 20 && m.english === true, JSON.stringify(m));
}
console.log('✓ разбор данных');

// ---------- fake Threads ----------
const post = (user, code, hoursAgo, likes, replies, text, extra = {}) => ({ post: {
  pk: `pk_${code}`, code, user: { pk: `id_${user}`, username: user }, caption: { text }, like_count: likes, taken_at: NOW - hoursAgo * H,
  text_post_app_info: { direct_reply_count: replies, repost_count: 2, quote_count: 0, ...extra },
} });
const USERS = {
  skye: { full_name: 'Skye Carter', follower_count: 250000, biography: 'just a girl', posts: [
    post('skye', 'S1', 5, 900, 140, 'what are you all doing this weekend'), post('skye', 'S2', 30, 700, 60, 'I just can not with this weather'),
    post('skye', 'S3', 60, 500, 20, 'so tired today but it is fine') ] },
  lola: { full_name: 'lola 🐰', is_verified: true, domFollowers: '90.5K followers', biography: 'be nice', bio_links: [{ url: 'https://example.com/lola' }],
    posts: [...Array(9)].map((_, i) => post('lola', `L${i}`, 4 + i * 14, 2000, 120, 'tell me what you think of this and be honest with me')) },
  lisa: { full_name: 'Lisa Thompson', follower_count: 40000, posts: [post('lisa', 'I1', 24 * 20, 300, 40, 'it has been a while, I know')] },
  bob: { full_name: 'Bob', follower_count: 120, posts: [] },
  spam_bot: { full_name: 'hot girl', follower_count: 3, bio_links: [{ url: 'https://beacons.ai/x' }] },
  kelly_hot: { full_name: 'Kelly', follower_count: 70000, bio_links: [{ url: 'https://example.com/k' }],
    posts: [...Array(8)].map((_, i) => post('kelly_hot', `K${i}`, 2 + i * 9, 800, 60, 'I do not know what to do with my day, tell me')) },
  megan_big: { full_name: 'Megan', follower_count: 500000, biography: 'all my links below', bio_links: [{ url: 'https://linktr.ee/megan' }],
    posts: [...Array(8)].map((_, i) => post('megan_big', `M${i}`, 3 + i * 10, 9000, 400, 'what do you all think about this, tell me in the replies')) },
  bigfan: { full_name: 'Big Fan', follower_count: 50000, posts: [post('bigfan', 'B1', 24 * 50, 3, 0, 'that is all I have to say')] },
  fan1: { full_name: 'Mark', follower_count: 80 }, fan2: { full_name: 'Don', follower_count: 12 },
  fan3: { full_name: 'Dale', follower_count: 40 }, fan_ru: { full_name: 'Иван', follower_count: 5 },
};
const FOLLOWING = { fan1: ['lola', 'lisa', 'bob'], fan2: ['lola', 'lisa'], fan3: ['lola', 'bob'], bigfan: ['lola'] };
const REPLIES = { S1: [['fan1', 'you are the best, I love this so much'], ['fan2', 'what a great picture, you look so good in it'],
  ['fan_ru', 'очень красивая фотография, мне нравится'], ['bigfan', 'this is what I like to see on my feed'], ['spam_bot', 'you are so pretty, check my bio']],
  S2: [['spam_bot', 'you are so pretty, check my bio'], ['fan1', 'the weather is not that bad if you ask me'], ['fan3', 'I think it is so nice that you are here']] };

// skye's Replies tab: three comments under megan_big (two with the same text), one under lola without reply_to_author.
const SKYE_REPLIES = [
  [post('megan_big', 'M0', 3, 9000, 400, 'x'), post('skye', 'C1', 2, 5, 0, 'you look so good, check my bio', { is_reply: true, reply_to_author: { username: 'megan_big' } })],
  [post('megan_big', 'M1', 13, 9000, 400, 'x'), post('skye', 'C2', 12, 4, 0, 'you look so good, check my bio', { is_reply: true, reply_to_author: { username: 'megan_big' } })],
  [post('megan_big', 'M2', 23, 9000, 400, 'x'), post('skye', 'C3', 22, 9, 1, 'this is what I needed today', { is_reply: true, reply_to_author: { username: 'megan_big' } })],
  [post('lola', 'L0', 4, 2000, 120, 'x'), post('skye', 'C4', 3, 2, 0, 'so true, I think that all the time')],
];
// spam_bot comments in bulk, mostly under kelly_hot.
const BOT_REPLIES = [...Array(12)].map((_, i) => [post(i % 4 ? 'kelly_hot' : 'megan_big', `X${i}`, 5, 1, 1, 'x'),
  post('spam_bot', `BC${i}`, 1 + i, 0, 0, 'you are so pretty, check my bio', { is_reply: true, reply_to_author: { username: i % 4 ? 'kelly_hot' : 'megan_big' } })]);
const POSTED = [];
const HOME = `<h1>home</h1><div id="open" style="cursor:pointer">What's new?</div><script>
  document.getElementById('open').onclick = () => {
    const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.style.cssText = 'position:fixed;inset:40px;background:#fff';
    d.innerHTML = '<div contenteditable="true" style="min-height:40px"></div><input type="file"><div role="button" id="go">Post</div>';
    document.body.append(d);
    d.querySelector('#go').onclick = async () => {
      await fetch('/api/graphql?post=' + encodeURIComponent(d.querySelector('[contenteditable]').innerText) + '&files=' + d.querySelector('input').files.length);
      d.remove();
    };
  };
</script>`;

const userJson = (name) => { const { posts, domFollowers, ...u } = USERS[name]; return { pk: `id_${name}`, username: name, profile_pic_url: `/pic/${name}.jpg`, ...u }; };
const blob = (data) => `<script type="application/json" data-sjs>${JSON.stringify({ require: [['Relay', null, null, [{ __bbox: { result: { data } } }]]] })}</script>`;
const DIALOG_JS = `<script>
  document.getElementById('fl').onclick = () => {
    const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.style.cssText = 'position:fixed;inset:40px;background:#fff;overflow:auto';
    d.innerHTML = '<div><span id="t1">Followers</span> <span id="t2">Following</span></div><div id="a"><a href="/@some_follower">some_follower</a></div><div id="b"></div>';
    document.body.append(d);
    d.querySelector('#t2').onclick = async () => {
      d.querySelector('#a').style.display = 'none';
      const r = await (await fetch('/api/graphql?following=' + NAME)).json();
      d.querySelector('#b').innerHTML = r.data.following.edges.map((e) => '<div style="height:60px"><a href="/@' + e.node.username + '">' + e.node.username + '</a></div>').join('');
    };
  };
</script>`;

const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const seg = url.pathname.split('/').filter(Boolean);
  const html = (body) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><body>${body}</body>`); };
  if (seg[0] === 'api') {
    if (url.searchParams.has('post')) { POSTED.push({ text: url.searchParams.get('post'), files: Number(url.searchParams.get('files')) }); res.writeHead(200); return res.end('{}'); }
    const list = FOLLOWING[url.searchParams.get('following')] || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: { following: { edges: list.map((u) => ({ node: userJson(u) })) } } }));
  }
  if (seg[0] === 'pic') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); }
  const name = (seg[0] || '').replace(/^@/, '');
  if (!seg[0]) return html(HOME);
  if (!USERS[name]) return html('<p>Sorry, this page is not available</p>');
  if (seg[1] === 'replies') {
    return html(blob({ data: { edges: (name === 'skye' ? SKYE_REPLIES : name === 'spam_bot' ? BOT_REPLIES : []).map((thread_items) => ({ node: { thread_items } })) } }) + '<h1>replies</h1>');
  }
  if (seg[1] === 'post') {
    const own = USERS[name].posts.find((p) => p.post.code === seg[2]);
    own.post.text_post_app_info.share_info = { quoted_post: post('quoted_guy', 'Q1', 99, 1, 0, 'quoted').post };
    const reps = (REPLIES[seg[2]] || []).map(([u, text], i) => ({ thread_items: [post(u, `R${seg[2]}${i}`, 1, 3, 0, text, { is_reply: true, reply_to_author: { username: name } })] }));
    return html(blob({ data: { edges: [{ node: { thread_items: [own] } }, ...reps.map((node) => ({ node }))] } }) + '<article>post</article>');
  }
  const u = USERS[name];
  const count = u.domFollowers || `${u.follower_count} followers`;
  html(blob({ user: userJson(name), mediaData: { edges: (u.posts || []).map((p) => ({ node: { thread_items: [p] } })) } })
    + `<h1>${name}</h1><span id="fl" style="cursor:pointer">${count}</span><p>my followers are the best</p><script>const NAME=${JSON.stringify(name)}</script>${DIALOG_JS}`);
});

// ---------- fake AdsPower ----------
const CHROME = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium'].find((p) => p && fs.existsSync(p));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-test-'));
let chrome = null, wsUrl = null, started = 0, stopped = 0;
function launchChrome() {
  return new Promise((resolve, reject) => {
    chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank']);
    let err = '';
    chrome.stderr.on('data', (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]); });
    chrome.on('exit', () => reject(new Error(`Chromium не запустился: ${err.slice(-300)}`)));
  });
}
const ads = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ok = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 0, msg: 'success', data })); };
  if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(200); return res.end(JSON.stringify({ code: -1, msg: 'Invalid API key' })); }
  if (url.pathname === '/status') return ok({});
  if (url.pathname === '/api/v1/user/list') return ok({ list: [{ user_id: 'prof1', name: 'US girl', serial_number: '7', group_name: 'threads' }] });
  if (url.pathname === '/api/v1/browser/active') return ok({ status: wsUrl ? 'Active' : 'Inactive', ws: wsUrl ? { puppeteer: wsUrl } : undefined });
  if (url.pathname === '/api/v1/browser/start') { wsUrl = await launchChrome(); started++; return ok({ ws: { puppeteer: wsUrl } }); }
  if (url.pathname === '/api/v1/browser/stop') { stopped++; chrome?.removeAllListeners('exit'); chrome?.kill(); wsUrl = null; return ok({}); }
  res.writeHead(404); res.end();
});

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CHROME) {
  console.log('⚠ Chromium не найден (задайте CHROME_PATH) — сквозной прогон пропущен');
  process.exit(0);
}

const sitePort = await listen(site);
const adsPort = await listen(ads);
const port = 4400 + Math.floor(Math.random() * 400);
const app = spawn(process.execPath, [path.join(ROOT, 'src/threads/server.js')], {
  env: { ...process.env, THREADS_HOME: path.join(tmp, 'data'), THREADS_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
});
const base = `http://127.0.0.1:${port}`;
const call = async (p, data) => {
  const r = await fetch(base + p, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const out = await r.json();
  if (!r.ok) throw new Error(`${p}: ${out.error}`);
  return out;
};

try {
  await new Promise((r) => app.stdout.once('data', r));
  // A cross-site form post (no JSON content type) and a foreign Host must be refused.
  assert.equal((await fetch(`${base}/api/run`, { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await new Promise((r) => http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example' } }, r))).statusCode, 403);

  await call('/api/settings', { adsUrl: `http://127.0.0.1:${adsPort}`, adsKey: 'test-key', threadsBase: `http://127.0.0.1:${sitePort}`,
    delayMin: 0, delayMax: 0, minOverlap: 2, profileScrolls: 1, followingScrolls: 2 });
  const { profiles } = await call('/api/adspower/profiles', {});
  assert.equal(profiles[0].id, 'prof1');
  await call('/api/settings', { adsProfile: 'prof1' });
  let st = await call('/api/seeds', { add: ['https://www.threads.com/@Skye', '@nobody_here'] });
  assert.deepEqual(st.seeds, ['skye', 'nobody_here']);
  assert.equal(st.settings.adsKey, undefined, 'ключ не должен уходить в браузер');

  await call('/api/run', {});
  for (let i = 0; i < 240; i++) { await sleep(500); st = await call('/api/state'); if (!st.job.running) break; }
  const logText = st.job.log.map((l) => `[${l.level}] ${l.msg}`).join('\n');
  assert.equal(st.job.running, false, 'парсинг не завершился');
  assert.ok(!st.job.log.some((l) => l.level === 'error'), logText);

  const acc = Object.fromEntries(st.accounts.map((a) => [a.username, a]));
  try {
    assert.equal(acc.skye.role, 'seed');
    assert.equal(acc.skye.followers, 250000);
    assert.equal(acc.lola.status, 'new');
    assert.equal(acc.lola.overlap, 4);
    assert.equal(acc.lola.followers, 90500, 'число подписчиков со страницы');
    assert.equal(acc.lola.verified, true);
    assert.equal(acc.lola.avatar, 'lola.jpg');
    assert.ok(acc.lola.metrics.postsPerWeek >= 7 && acc.lola.metrics.avgReplies === 120, JSON.stringify(acc.lola.metrics));
    assert.deepEqual(acc.lola.sources, ['skye']);
    assert.equal(acc.lisa.status, 'filtered');
    assert.match(acc.lisa.filterReason, /редко постит/);
    assert.equal(acc.bigfan.status, 'filtered');
    assert.match(acc.bigfan.via, /комментатор/);
    assert.equal(acc.bob.status, 'filtered', 'bob: пересечение 2, но мало подписчиков');
    for (const no of ['fan_ru', 'quoted_guy', 'some_follower', 'nobody_here']) assert.equal(acc[no], undefined, `${no} не должен попасть в кандидаты`);
    assert.equal(st.audienceScanned, 5);
    assert.equal(st.lastRun.found, 3);
    assert.equal(acc.spam_bot.role, 'scout', 'массовый комментатор должен стать ищейкой');
    assert.ok(acc.spam_bot.commentStats.perDay >= 8 && acc.spam_bot.commentStats.templated === 100, JSON.stringify(acc.spam_bot.commentStats));
    assert.equal(acc.fan1, undefined);
    assert.equal(acc.kelly_hot.status, 'new');
    assert.match(acc.kelly_hot.via, /комментируют: @spam_bot/);
    assert.equal(acc.kelly_hot.scoutComments, 9);
    assert.equal(acc.megan_big.scoutComments, 3);
    assert.ok(acc.kelly_hot.metrics.posts30d === 8 && acc.kelly_hot.metrics.avgIntervalH === 9 && acc.kelly_hot.metrics.activeHours.length, JSON.stringify(acc.kelly_hot.metrics));
    assert.equal(st.newPosts.filter((p) => p.by === 'skye').length, 3);
    assert.equal(st.lastRun.newScouts, 1);
    assert.equal(acc.megan_big.status, 'new');
    assert.match(acc.megan_big.via, /комментируют: @skye/);
    assert.deepEqual(acc.megan_big.commentedBy, ['skye', 'spam_bot']);
    assert.deepEqual(acc.megan_big.funnel, ['мультиссылка']);
    assert.deepEqual(acc.skye.commentStats.targets[0], { to: 'megan_big', count: 3 });
    assert.equal(acc.skye.commentStats.templated, 50);
    assert.equal(acc.skye.commentStats.cta, 50);
    assert.equal(acc.skye.comments, undefined, 'история комментариев отдаётся только лентой');
    assert.equal(st.feed.length, 16);
    assert.equal(st.feed.find((c) => c.code === 'C4').to, 'lola', 'адресат по порядку в ветке');
    assert.equal(st.lastRun.newComments, 4);
    assert.equal(started, 1);
    assert.equal(stopped, 1, 'браузер, который открыл парсер, должен быть закрыт');
  } catch (e) { console.error(logText); throw e; }
  assert.equal((await fetch(`${base}/avatar/lola.jpg`)).status, 200);

  st = await call('/api/account/lola', { status: 'approved' });
  st = await call('/api/seeds', { add: ['lola'] });
  assert.equal(st.accounts.find((a) => a.username === 'lola').role, 'seed');
  const csv = await (await fetch(`${base}/api/export.csv`)).text();
  assert.ok(csv.includes('"lola"') && !csv.includes('"lisa"'));
  assert.ok(!fs.readFileSync(path.join(tmp, 'data', 'db.json'), 'utf8').includes('quoted_guy'));
  console.log('✓ сквозной прогон: AdsPower → Threads → кандидаты → панель');

  const wait = async () => { for (let i = 0; i < 120; i++) { await sleep(500); st = await call('/api/state'); if (!st.job.running) break; } return st.job.log.map((l) => `[${l.level}] ${l.msg}`).join('\n'); };
  await call('/api/seeds', { remove: ['lola'] });   // back to the approved base: still tracked
  await call('/api/run', { mode: 'watch' });
  let out = await wait();
  assert.ok(!st.job.running && !st.job.log.some((l) => l.level === 'error'), out);
  assert.deepEqual(st.tracked, ['skye', 'nobody_here', 'lola']);
  assert.equal(st.lastRun.mode, 'watch');
  assert.equal(st.lastRun.newComments, 0, 'те же комментарии не считаются новыми дважды');
  assert.equal(st.feed.length, 16);
  assert.deepEqual(st.scouts, ['spam_bot']);
  st = await call('/api/seeds', { kind: 'scout', add: ['@gone_bot'] });
  await call('/api/run', { mode: 'watch' }); await wait();
  await call('/api/run', { mode: 'watch' }); out = await wait();
  assert.equal(st.accounts.find((a) => a.username === 'gone_bot').dead, true, out);
  assert.deepEqual(st.scouts, ['spam_bot']);
  console.log('✓ слежение: повторный сбор комментариев без дублей');

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await assert.rejects(call('/api/post', { text: 'x'.repeat(501) }), /500/);
  await call('/api/post', { text: 'hello from the test stand', image: png });
  out = await wait();
  assert.ok(!st.job.running && !st.job.log.some((l) => l.level === 'error'), out);
  assert.deepEqual(POSTED, [{ text: 'hello from the test stand', files: 1 }]);
  assert.equal(st.posts[0].ok, true);
  console.log('✓ постинг: текст и картинка ушли один раз');
} finally {
  app.kill();
  chrome?.removeAllListeners('exit');
  chrome?.kill();
  site.close(); ads.close();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
