// One parsing run:
//   references → their most commented posts → people who commented →
//   who those people follow → accounts followed by several of them → evaluate each.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { AdsPower } from './adspower.js';
import { Threads, Blocked } from './threads.js';
import { metrics, score, femaleNameHint, isEnglish } from './extract.js';
import { load, save, AVATARS, DEBUG } from './db.js';

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

function filterReason(acc, s) {
  const m = acc.metrics || {};
  if (acc.private) return 'закрытый профиль';
  if ((acc.followers ?? 0) < s.minFollowers) return `мало подписчиков (${acc.followers ?? '?'})`;
  if (m.postsPerWeek < s.minPostsPerWeek) return `редко постит (${m.postsPerWeek}/нед)`;
  if (m.avgReplies < s.minAvgReplies) return `мало комментариев (${m.avgReplies} в среднем)`;
  if (s.englishOnly && m.english === false) return 'посты не на английском';
  return null;
}

export async function crawl({ emit, isStopped }) {
  const db = load();
  const s = db.settings;
  const log = (msg, level = 'info') => emit('log', { t: new Date().toISOString(), level, msg });
  const progress = (phase, done, total) => emit('progress', { phase, done, total });
  const check = () => { if (isStopped()) throw new Stop(); };
  const stats = { seeds: 0, commenters: 0, scanned: 0, evaluated: 0, found: 0 };
  if (!db.seeds.length) throw new Error('Добавьте хотя бы один референсный аккаунт');

  const ads = new AdsPower(s.adsUrl, s.adsKey);
  log('Открываю профиль AdsPower…');
  const { ws, started } = await ads.open(s.adsProfile);
  const browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  const t = new Threads(page, { base: s.threadsBase, delayMin: s.delayMin, delayMax: s.delayMax, debugDir: DEBUG, check });
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
    acc.score = score(acc);
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

  try {
    if (!(await t.loggedIn())) log('Похоже, в профиле не выполнен вход в Threads: списки подписок могут не открыться.', 'warn');

    // 1. References and the people who comment on them.
    const pool = new Map();
    let i = 0;
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
          const c = pool.get(rep.username) || { seeds: new Set(), comments: 0, english: null };
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

    // 2. Open the following list of the most relevant commenters.
    const seedSet = new Set(db.seeds);
    for (const [u, c] of pool) {
      const a = db.audience[u];
      if (a) a.seeds = [...new Set([...(a.seeds || []), ...c.seeds])];
    }
    const queue = [...pool.entries()]
      .filter(([u, c]) => !seedSet.has(u) && !(s.englishOnly && c.english === false) && !fresh(db.audience[u]?.scannedAt, s.rescanDays))
      .sort((a, b) => b[1].seeds.size - a[1].seeds.size || b[1].comments - a[1].comments)
      .slice(0, s.maxAudience);
    log(`Комментаторов: ${pool.size}. Открываю подписки у ${queue.length}`);
    const extra = new Map();   // candidates that did not come from a following list
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

    // 3. Optional keyword search as one more source.
    for (const kw of s.keywords) {
      const r = await step(`поиск «${kw}»`, () => t.search(kw, { scrolls: s.profileScrolls }));
      if (!r) continue;
      log(`Поиск «${kw}»: ${r.authors.length} авторов`);
      for (const u of r.authors) if (!seedSet.has(u) && !extra.has(u)) extra.set(u, `поиск: ${kw}`);
    }

    // 4. Rank candidates by audience overlap and evaluate the best ones.
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
      .filter(([u]) => !fresh(db.accounts[u]?.evaluatedAt, s.reevalDays))
      .sort((a, b) => b[1].overlap - a[1].overlap)
      .slice(0, s.maxCandidates);
    log(`Кандидатов: ${wanted.size} (ещё ${below} ниже порога пересечения ${s.minOverlap}). Проверяю ${todo.length}`);
    i = 0;
    for (const [u, c] of todo) {
      progress('Кандидаты', i++, todo.length);
      const r = await step(`@${u}`, () => t.profile(u, { scrolls: s.profileScrolls }));
      if (!r || !r.found) continue;
      const acc = await saveCard(u, r, {
        role: 'candidate', overlap: c.overlap, followedBy: c.by, sources: [...c.sources], via: extra.get(u) || null,
      });
      const reason = filterReason(acc, s);
      if (acc.status === 'new' || acc.status === 'filtered') acc.status = reason ? 'filtered' : 'new';
      acc.filterReason = reason;
      stats.evaluated++;
      if (!reason) stats.found++;
      log(`@${u}: ${reason ? `отсеян — ${reason}` : `подходит, оценка ${acc.score}`}`);
      if (i % 3 === 0) { save(); emit('change', {}); }
    }
    progress('Кандидаты', todo.length, todo.length);
    log(`Готово. Референсов: ${stats.seeds}, комментаторов: ${stats.commenters}, просмотрено подписок: ${stats.scanned}, проверено кандидатов: ${stats.evaluated}, подходящих: ${stats.found}`);
    return stats;
  } finally {
    db.lastRun = { at: new Date().toISOString(), ...stats };
    save();
    emit('change', {});
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    if (started && s.closeBrowser) await ads.stop(s.adsProfile).catch(() => {});
  }
}
