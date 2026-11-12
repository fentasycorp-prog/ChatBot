// One parsing run:
//   references → their most commented posts → people who commented →
//   who those people follow → accounts followed by several of them → evaluate each.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { AdsPower } from './adspower.js';
import { Threads, Blocked } from './threads.js';
import { metrics, score, femaleNameHint, isEnglish, funnel, commentStats } from './extract.js';
import { load, save, AVATARS, DEBUG } from './db.js';
import { tgSend } from './telegram.js';

export class Stop extends Error { constructor() { super('Остановлено'); this.name = 'Stop'; } }

const DAY = 86400000;
const fresh = (iso, days) => iso && Date.now() - Date.parse(iso) < days * DAY;

// Count, for every followed account, how many scanned commenters follow it.
export function tally(db) {
  const seeds = new Set(db.seeds);
  const map = new Map();
  for (const [fan, a] of Object.entries(db.audience)) {
    for (const u of a.following || []) {
      if (seeds.has(u) || u === fan) continue;
      const c = map.get(u) || { overlap: 0, by: [], sources: new Set() };
      c.overlap++;
      if (c.by.length < 8) c.by.push(fan);
      for (const s of a.seeds || []) c.sources.add(s);
      map.set(u, c);
    }
  }
  return map;
}

export function filterReason(acc, s) {
  const m = acc.metrics || {};
  if (acc.private) return 'закрытый профиль';
  if ((acc.followers ?? 0) < s.minFollowers) return `мало подписчиков (${acc.followers ?? '?'})`;
  if (s.requireLink && !(acc.links || []).length) return 'нет ссылки в профиле';
  if (m.avgLikes < s.minAvgLikes) return `мало лайков (${m.avgLikes} в среднем)`;
  if (m.postsPerWeek < s.minPostsPerWeek) return `редко постит (${m.postsPerWeek}/нед)`;
  if (m.avgReplies < s.minAvgReplies) return `мало комментариев (${m.avgReplies} в среднем)`;
  if (s.englishOnly && m.english === false) return 'посты не на английском';
  return null;
}

// Connect to the AdsPower profile's browser and open a tab of our own.
export async function openSession(s, check) {
  const ads = new AdsPower(s.adsUrl, s.adsKey);
  const { ws, started } = await ads.open(s.adsProfile);
  const browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  const t = new Threads(page, { base: s.threadsBase, delayMin: s.delayMin, delayMax: s.delayMax, debugDir: DEBUG, check });
  return {
    t,
    async close() {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      if (started && s.closeBrowser) await ads.stop(s.adsProfile).catch(() => {});
    },
  };
}

// Authors we keep watching: references plus everyone approved into the base.
export const tracked = (db) => [...new Set([...db.seeds,
  ...Object.values(db.accounts).filter((a) => a.status === 'approved' && a.role !== 'seed').map((a) => a.username)])];

// Scouts: mass commenters we do not copy, only read — their Replies tab points at threads where the niche gathers.
export const scouts = (db) => Object.values(db.accounts).filter((a) => a.role === 'scout' && !a.dead).map((a) => a.username);

// Keep a tracked author's own posts so new ones stand out on the next run.
function mergePosts(acc, posts) {
  const known = new Map((acc.posts || []).map((p) => [p.code, p]));
  let added = 0;
  for (const p of posts) {
    if (!p.code || p.isReply) continue;
    if (!known.has(p.code)) added++;
    known.set(p.code, { code: p.code, text: p.text.slice(0, 280), likes: p.likes, replies: p.replies, takenAt: p.takenAt, seenAt: known.get(p.code)?.seenAt || new Date().toISOString() });
  }
  acc.posts = [...known.values()].sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0)).slice(0, 60);
  acc.lastPostCode = acc.posts[0]?.code || null;
  return added;
}

// Add newly seen comments to an author's history; returns how many were new.
function mergeComments(acc, list) {
  const known = new Map((acc.comments || []).map((c) => [c.code, c]));
  let added = 0;
  for (const c of list) {
    if (!c.code) continue;
    if (!known.has(c.code)) added++;
    known.set(c.code, { ...c, seenAt: known.get(c.code)?.seenAt || new Date().toISOString() });
  }
  acc.comments = [...known.values()].sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0)).slice(0, 300);
  acc.commentStats = commentStats(acc.comments);
  acc.commentsAt = new Date().toISOString();
  return added;
}

// mode 'full' — everything; 'watch' — only refresh tracked authors and their comments.
export async function crawl({ emit, isStopped, mode = 'full' }) {
  const db = load();
  const s = db.settings;
  const log = (msg, level = 'info') => emit('log', { t: new Date().toISOString(), level, msg });
  const progress = (phase, done, total) => emit('progress', { phase, done, total });
  const check = () => { if (isStopped()) throw new Stop(); };
  const stats = { mode, seeds: 0, commenters: 0, scanned: 0, evaluated: 0, found: 0, newComments: 0, newPosts: 0, newScouts: 0, autoTracked: 0 };
  if (!tracked(db).length && !scouts(db).length) throw new Error('Добавьте хотя бы один референсный аккаунт');

  log('Открываю профиль AdsPower…');
  const session = await openSession(s, check);
  const t = session.t;
  let failures = 0;

  // Run one step; a single bad page must not end the run, but a streak of them should.
  const step = async (label, fn) => {
    check();
    try { const r = await fn(); failures = 0; return r; } catch (e) {
      if (e instanceof Stop || e instanceof Blocked) throw e;
      log(`${label}: ${e.message.split('\n')[0]}`, 'warn');
      await t.dump(label);
      if (++failures >= 5) throw new Error('Пять ошибок подряд — останавливаюсь, чтобы не нагружать аккаунт. Скриншоты лежат в папке debug.');
      return null;
    }
  };

  const saveCard = async (name, r, extra) => {
    const prev = db.accounts[name] || { username: name, foundAt: new Date().toISOString(), status: 'new' };
    const u = r.user;
    const acc = {
      ...prev, ...extra,
      fullName: u.full_name ?? prev.fullName ?? '',
      bio: u.bio ?? prev.bio ?? '',
      links: u.links ?? prev.links ?? [],
      followers: u.followers ?? prev.followers ?? null,
      verified: u.verified ?? prev.verified ?? false,
      private: u.private ?? prev.private ?? false,
      metrics: metrics(r.posts, u.followers ?? prev.followers),
      topPosts: r.posts.filter((p) => !p.isReply && p.code)
        .sort((a, b) => (b.replies ?? 0) - (a.replies ?? 0)).slice(0, 3)
        .map((p) => ({ code: p.code, text: p.text.slice(0, 280), likes: p.likes, replies: p.replies, takenAt: p.takenAt })),
      evaluatedAt: new Date().toISOString(),
    };
    acc.femaleName = femaleNameHint(acc.fullName, name);
    acc.funnel = funnel(acc.links, acc.bio);
    acc.score = score(acc);
    if (acc.role === 'seed' || acc.status === 'approved') stats.newPosts += mergePosts(acc, r.posts);
    if (u.pic && u.pic !== prev.picUrl) {
      const buf = await t.avatar(u.pic);
      if (buf) {
        fs.mkdirSync(AVATARS, { recursive: true });
        fs.writeFileSync(path.join(AVATARS, `${name}.jpg`), buf);
        acc.avatar = `${name}.jpg`;
      }
      acc.picUrl = u.pic;
    }
    db.accounts[name] = acc;
    return acc;
  };

  // Read what tracked authors comment and where. refresh(u) says whether to reload the profile card too.
  const watch = async (refresh) => {
    // Authors added by following scouts are watched for new posts only (on-duty mode); re-reading
    // every one of them here would make a base of hundreds take hours.
    const authors = new Set(tracked(db).filter((u) => !db.accounts[u]?.auto));
    const list = [...authors, ...scouts(db).filter((u) => !authors.has(u))];
    let n = 0;
    for (const u of list) {
      progress('Комментинг авторов', n++, list.length);
      if (authors.has(u) && refresh(u)) {
        const r = await step(`@${u}`, () => t.profile(u, { scrolls: s.profileScrolls }));
        if (r?.found) await saveCard(u, r, {});
      }
      if (!db.accounts[u]) continue;
      const res = await step(`комментарии @${u}`, () => t.comments(u, { scrolls: s.commentScrolls }));
      if (!res) continue;
      const list2 = res.list;
      if (!authors.has(u)) {
        // A scout that stopped returning anything twice in a row is banned or deleted.
        const acc = db.accounts[u];
        acc.misses = res.found || list2.length ? 0 : (acc.misses || 0) + 1;
        if (acc.misses >= 2) { acc.dead = true; log(`@${u}: ищейка больше не отвечает — помечена как выбывшая`, 'warn'); save(); continue; }
      }
      const added = mergeComments(db.accounts[u], list2);
      stats.newComments += added;
      const top = db.accounts[u].commentStats.targets.slice(0, 3).map((x) => `@${x.to}`).join(', ');
      log(`@${u}: комментариев ${list2.length}, новых ${added}${top ? `, чаще всего у ${top}` : ''}`);
      save();
      emit('change', {});
    }
    progress('Комментинг авторов', list.length, list.length);
  };

  try {
    if (!(await t.loggedIn())) log('Похоже, в профиле не выполнен вход в Threads: списки подписок могут не открыться.', 'warn');
    const seedSet = new Set(db.seeds);
    const extra = new Map();   // candidates that did not come from a following list
    let i = 0;
    if (mode === 'watch') await watch(() => true);

    if (mode === 'full') {
    // 1. References and the people who comment on them.
    const pool = new Map();
    for (const seed of db.seeds) {
      progress('Референсы', i++, db.seeds.length);
      const r = await step(`@${seed}`, () => t.profile(seed, { scrolls: s.profileScrolls }));
      if (!r) continue;
      if (!r.found) { log(`@${seed}: профиль не найден`, 'warn'); continue; }
      await saveCard(seed, r, { role: 'seed' });
      stats.seeds++;
      const top = r.posts.filter((p) => !p.isReply && p.code)
        .sort((a, b) => (b.replies ?? 0) - (a.replies ?? 0)).slice(0, s.postsPerSeed);
      log(`@${seed}: ${r.posts.length} постов, смотрю комментарии под ${top.length}`);
      for (const post of top) {
        const reps = await step(`@${seed}/post/${post.code}`, () => t.replies(seed, post.code, { scrolls: s.profileScrolls }));
        const seen = new Set();
        for (const rep of reps || []) {
          if (seen.size >= s.commentersPerPost && !seen.has(rep.username)) continue;
          seen.add(rep.username);
          const c = pool.get(rep.username) || { seeds: new Set(), comments: 0, english: null, texts: new Set(), cta: false };
          const norm = rep.text.toLowerCase().replace(/[^\p{L}\s]/gu, '').trim();
          if (norm.split(/\s+/).length >= 3 && c.texts.has(norm)) c.repeats = true;
          c.texts.add(norm);
          if (/bio|profile|my page|dm me/i.test(rep.text)) c.cta = true;
          c.seeds.add(seed);
          c.comments++;
          const en = isEnglish(rep.text);
          if (en != null) c.english = c.english || en;
          pool.set(rep.username, c);
        }
      }
      save();
      emit('change', {});
    }
    progress('Референсы', db.seeds.length, db.seeds.length);
    stats.commenters = pool.size;
    await watch((u) => !seedSet.has(u));

    // 2. Open the following list of the most relevant commenters.
    for (const [u, c] of pool) {
      const a = db.audience[u];
      if (a) a.seeds = [...new Set([...(a.seeds || []), ...c.seeds])];
    }
    const queue = [...pool.entries()]
      .filter(([u, c]) => !seedSet.has(u) && !(s.englishOnly && c.english === false) && !fresh(db.audience[u]?.scannedAt, s.rescanDays))
      .sort((a, b) => b[1].seeds.size - a[1].seeds.size || b[1].comments - a[1].comments)
      .slice(0, s.maxAudience);
    log(`Комментаторов: ${pool.size}. Открываю подписки у ${queue.length}`);
    i = 0;
    for (const [u, c] of queue) {
      progress('Аудитория', i++, queue.length);
      const r = await step(`подписки @${u}`, () => t.following(u, { scrolls: s.followingScrolls }));
      if (!r) continue;
      db.audience[u] = { seeds: [...c.seeds], following: r.following || [], hidden: r.following == null, scannedAt: new Date().toISOString() };
      stats.scanned++;
      if (r.following == null) log(`@${u}: список подписок не открылся (${r.error || 'скрыт'})`, 'warn');
      else log(`@${u}: подписан на ${r.following.length}`);
      // A commenter with a big audience may be a creator from the same niche.
      if ((r.user.followers ?? 0) >= s.minFollowers) extra.set(u, `комментатор у @${[...c.seeds][0]}`);
      if (i % 5 === 0) save();
    }
    progress('Аудитория', queue.length, queue.length);
    save();

    // 2b. The busiest commenters: if one comments in bulk, keep it as a scout.
    const suspects = [...pool.entries()]
      .filter(([u]) => !seedSet.has(u) && !db.accounts[u])
      .sort((a, b) => (Number(b[1].repeats || false) + Number(b[1].cta)) - (Number(a[1].repeats || false) + Number(a[1].cta)) || b[1].comments - a[1].comments)
      .slice(0, s.scoutChecks);
    i = 0;
    for (const [u] of suspects) {
      progress('Поиск ищеек', i++, suspects.length);
      const res = await step(`комментарии @${u}`, () => t.comments(u, { scrolls: s.commentScrolls }));
      if (!res) continue;
      const cs = commentStats(res.list);
      if (cs.perDay < s.scoutMinPerDay) continue;
      db.accounts[u] = { username: u, role: 'scout', status: 'scout', foundAt: new Date().toISOString(),
        fullName: res.user.full_name || '', bio: res.user.bio || '', links: res.user.links || [], followers: res.user.followers ?? null };
      db.accounts[u].funnel = funnel(db.accounts[u].links, db.accounts[u].bio);
      mergeComments(db.accounts[u], res.list);
      stats.newScouts++;
      log(`@${u}: массовый комментатор (${cs.perDay} в день) — добавлен в ищейки`);
    }
    if (suspects.length) { progress('Поиск ищеек', suspects.length, suspects.length); save(); }

    // 3. Optional keyword search as one more source.
    for (const kw of s.keywords) {
      const r = await step(`поиск «${kw}»`, () => t.search(kw, { scrolls: s.profileScrolls }));
      if (!r) continue;
      log(`Поиск «${kw}»: ${r.authors.length} авторов`);
      for (const u of r.authors) if (!seedSet.has(u) && !extra.has(u)) extra.set(u, `поиск: ${kw}`);
    }
    }

    // 4. Accounts under whose posts tracked authors comment: creators promote themselves next to bigger ones.
    const trackedSet = new Set([...tracked(db), ...Object.values(db.accounts).filter((a) => a.role === 'scout').map((a) => a.username)]);
    const targets = new Map();
    for (const u of trackedSet) {
      for (const c of db.accounts[u]?.comments || []) {
        if (!c.to || trackedSet.has(c.to)) continue;
        const x = targets.get(c.to) || { authors: new Set(), n: 0, scoutN: 0 };
        if (db.accounts[u].role === 'scout') x.scoutN++;
        x.authors.add(u);
        x.n++;
        targets.set(c.to, x);
      }
    }
    for (const [u, x] of targets) {
      if (db.accounts[u]) Object.assign(db.accounts[u], { commentedBy: [...x.authors], scoutComments: x.scoutN });
      if ((x.authors.size >= 2 || x.n >= 3 || x.scoutN >= s.minScoutComments) && !extra.has(u)) extra.set(u, `у неё комментируют: ${[...x.authors].map((a) => `@${a}`).join(', ')}`);
    }

    // 5. Rank candidates by audience overlap and evaluate the best ones.
    const counts = tally(db);
    for (const [u, c] of counts) {
      const acc = db.accounts[u];
      if (acc && acc.role !== 'seed') Object.assign(acc, { overlap: c.overlap, followedBy: c.by, sources: [...c.sources] }, { score: score({ ...acc, overlap: c.overlap }) });
    }
    const wanted = new Map();
    for (const [u, c] of counts) if (c.overlap >= s.minOverlap) wanted.set(u, c);
    for (const [u] of extra) if (!wanted.has(u)) wanted.set(u, counts.get(u) || { overlap: 0, by: [], sources: new Set() });
    const below = [...counts.values()].filter((c) => c.overlap < s.minOverlap).length;
    const todo = [...wanted.entries()]
      .filter(([u]) => !trackedSet.has(u) && !fresh(db.accounts[u]?.evaluatedAt, s.reevalDays))
      .sort((a, b) => b[1].overlap - a[1].overlap || (targets.get(b[0])?.n || 0) - (targets.get(a[0])?.n || 0))
      .slice(0, s.maxCandidates);
    log(`Кандидатов: ${wanted.size} (ещё ${below} ниже порога пересечения ${s.minOverlap}). Проверяю ${todo.length}`);
    i = 0;
    for (const [u, c] of todo) {
      progress('Кандидаты', i++, todo.length);
      const r = await step(`@${u}`, () => t.profile(u, { scrolls: s.profileScrolls }));
      if (!r || !r.found) continue;
      const acc = await saveCard(u, r, {
        role: 'candidate', overlap: c.overlap, followedBy: c.by, sources: [...c.sources], via: extra.get(u) || null,
        commentedBy: [...(targets.get(u)?.authors || [])], scoutComments: targets.get(u)?.scoutN || 0,
      });
      const reason = filterReason(acc, s);
      if (acc.status === 'new' || acc.status === 'filtered') acc.status = reason ? 'filtered' : 'new';
      // Authors our scouts comment under go straight into the tracked base.
      if (acc.status === 'new' && s.autoTrack && acc.scoutComments > 0) { acc.status = 'approved'; acc.auto = true; stats.autoTracked++; }
      acc.filterReason = reason;
      stats.evaluated++;
      if (!reason) stats.found++;
      log(`@${u}: ${reason ? `отсеян — ${reason}` : acc.auto && acc.status === 'approved' ? 'под ней комментируют ищейки — добавлена в базу слежения' : `подходит, оценка ${acc.score}`}`);
      if (i % 3 === 0) { save(); emit('change', {}); }
    }
    progress('Кандидаты', todo.length, todo.length);
    log(`Готово. Добавлено в базу по следам ищеек: ${stats.autoTracked}. Новых ищеек: ${stats.newScouts}, новых постов авторов: ${stats.newPosts}, новых комментариев: ${stats.newComments}. Референсов: ${stats.seeds}, комментаторов: ${stats.commenters}, просмотрено подписок: ${stats.scanned}, проверено кандидатов: ${stats.evaluated}, подходящих: ${stats.found}`);
    return stats;
  } finally {
    db.lastRun = { at: new Date().toISOString(), ...stats };
    db.lastWatchAt = db.lastRun.at;
    save();
    emit('change', {});
    await session.close();
  }
}

// On-duty mode: keep checking the Following feed (plus a few base authors directly, in turn)
// and signal every fresh post of a base author. Runs until stopped.
export async function monitor({ emit, isStopped, forMs = 0 }) {
  const startedAt = Date.now();
  const db = load();
  const s = db.settings;
  const log = (msg, level = 'info') => emit('log', { t: new Date().toISOString(), level, msg });
  const check = () => { if (isStopped()) throw new Stop(); };
  if (!tracked(db).some((u) => db.accounts[u])) throw new Error('В базе нет авторов: сначала запустите «Парсинг» или «Обновить слежение»');
  if (!s.tgToken || !s.tgChat) log('Telegram не настроен — сигналы будут только в этом журнале', 'warn');
  log('Открываю профиль AdsPower…');
  const session = await openSession(s, check);
  const t = session.t;
  let fails = 0, cycle = 0, turn = 0, alerts = 0;

  const handle = async (posts) => {
    const base = new Set(tracked(db));
    let changed = false;
    for (const p of posts) {
      const acc = db.accounts[p.username];
      if (!acc || !base.has(p.username) || p.isReply || !p.code || (acc.posts || []).some((x) => x.code === p.code)) continue;
      mergePosts(acc, [p]);
      changed = true;
      const ageMin = p.takenAt ? (Date.now() / 1000 - p.takenAt) / 60 : null;
      if (ageMin == null || ageMin > s.alertMaxAgeMin) continue;
      alerts++;
      const link = `${s.threadsBase}/@${p.username}/post/${p.code}`;
      log(`НОВЫЙ ПОСТ @${p.username} (${Math.max(0, Math.round(ageMin))} мин назад): ${link}`);
      await tgSend(s, `🆕 @${p.username} — новый пост, ${Math.max(0, Math.round(ageMin))} мин назад\n\n${p.text.slice(0, 500) || '(без текста)'}\n\n${link}`)
        .catch((e) => log(e.message, 'warn'));
    }
    if (changed) { save(); emit('change', {}); }
  };

  try {
    log(`Дежурство: проверяю ленту подписок каждые ${s.monitorEvery} с, сигнал о постах моложе ${s.alertMaxAgeMin} мин`);
    for (;;) {
      check();
      if (forMs && Date.now() - startedAt > forMs) return;
      try {
        const feed = await t.feed(s.feedPath);
        if (cycle === 0) log(`В ленте подписок постов: ${feed.length}`);
        await handle(feed);
        const list = tracked(db).filter((u) => db.accounts[u]);
        for (let k = 0; k < Math.min(s.profilesPerCycle, list.length); k++) {
          const r = await t.profile(list[turn++ % list.length], { scrolls: 0 });
          await handle(r.posts);
        }
        fails = 0;
      } catch (e) {
        if (e instanceof Stop || e instanceof Blocked) throw e;
        log(`Проверка не удалась: ${e.message.split('\n')[0]}`, 'warn');
        if (++fails >= 5) throw new Error('Пять неудачных проверок подряд — дежурство остановлено');
      }
      cycle++;
      emit('progress', { phase: `Дежурство: проверок ${cycle}, сигналов ${alerts}`, done: 0, total: 0 });
      for (let i = 0; i < s.monitorEvery; i++) { check(); await new Promise((r) => setTimeout(r, 1000)); }
    }
  } catch (e) {
    if (!(e instanceof Stop)) await tgSend(s, `⚠️ Дежурство остановлено: ${e.message.split('\n')[0]}`).catch(() => {});
    throw e;
  } finally {
    save();
    await session.close();
  }
}

// One button: read the scouts, add the authors they comment under, follow them, then stay on duty.
// Every few hours the scouts are read again so the base keeps growing.
export async function auto(ctx) {
  const db = load();
  const log = (msg, level = 'info') => ctx.emit('log', { t: new Date().toISOString(), level, msg });
  for (;;) {
    await crawl({ ...ctx, mode: 'watch' });
    if (!tracked(db).some((u) => db.accounts[u])) throw new Error('Авторы не нашлись. Добавьте другой аккаунт, который комментирует чаще, или смягчите фильтр в настройках.');
    if (db.settings.autoFollow && tracked(db).some((u) => db.accounts[u] && !db.accounts[u].followed)) {
      await followBase(ctx).catch((e) => { if (e instanceof Stop || e instanceof Blocked) throw e; log(e.message.split('\n')[0], 'warn'); });
    }
    await monitor({ ...ctx, forMs: db.settings.rescanHours * 3600e3 });
  }
}

// Follow base authors from our profile so their posts show up in the Following feed.
export async function followBase({ emit, isStopped }) {
  const db = load();
  const s = db.settings;
  const log = (msg, level = 'info') => emit('log', { t: new Date().toISOString(), level, msg });
  const check = () => { if (isStopped()) throw new Stop(); };
  const list = tracked(db).filter((u) => db.accounts[u] && !db.accounts[u].followed).slice(0, s.followPerRun);
  if (!list.length) throw new Error('Подписываться не на кого: все авторы базы уже отмечены как подписки');
  log('Открываю профиль AdsPower…');
  const session = await openSession(s, check);
  let fails = 0, n = 0;
  try {
    for (const u of list) {
      emit('progress', { phase: 'Подписка', done: n++, total: list.length });
      check();
      try {
        const r = await session.t.follow(u);
        db.accounts[u].followed = true;
        save();
        fails = 0;
        log(`@${u}: ${r === 'already' ? 'уже подписаны' : 'подписались'}`);
      } catch (e) {
        if (e instanceof Stop || e instanceof Blocked) throw e;
        log(`@${u}: ${e.message.split('\n')[0]}`, 'warn');
        if (++fails >= 3) throw new Error('Три ошибки подряд — подписка остановлена. Скриншоты лежат в папке debug.');
      }
    }
    const left = tracked(db).filter((u) => db.accounts[u] && !db.accounts[u].followed).length;
    log(`Готово.${left ? ` Осталось ещё ${left} — нажмите ещё раз позже.` : ''}`);
  } finally {
    emit('change', {});
    await session.close();
  }
}

// Publish one ordinary post from the profile's own account.
export async function publish({ emit, text, image }) {
  const db = load();
  const log = (msg, level = 'info') => emit('log', { t: new Date().toISOString(), level, msg });
  log('Открываю профиль AdsPower…');
  const session = await openSession(db.settings, () => {});
  const entry = { at: new Date().toISOString(), text, image: Boolean(image), ok: false };
  try {
    await session.t.post(text, image);
    entry.ok = true;
    log('Пост опубликован');
  } catch (e) {
    entry.error = e.message.split('\n')[0];
    throw e;
  } finally {
    db.posts = [entry, ...(db.posts || [])].slice(0, 100);
    save();
    emit('change', {});
    await session.close();
  }
}
