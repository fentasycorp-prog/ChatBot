// Category research. For every category (Threads topic):
//   its feed → the authors posting there → the best of them, checked on their profiles →
//   the fans commenting under them → whom else those fans comment on, when, and under which topics.
// Related topics used by a category's authors become categories too. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { load, save, AVATARS } from './db.js';
import { openSession, filterReason, Stop } from './crawler.js';
import { Blocked } from './threads.js';
import { metrics, funnel, femaleNameHint, isEnglish, tagName } from './extract.js';

const DAY = 86400000;
const fresh = (iso, days) => iso && Date.now() - Date.parse(iso) < days * DAY;
const cap = (x) => Math.max(0, Math.min(1, x));
const good = (a) => Boolean(a && a.evaluatedAt && !a.filterReason && a.role !== 'scout' && a.status !== 'rejected');

// Steady posting first, then how much discussion the posts get.
const catScore = (m) => Math.round(50 * cap((m?.postsPerWeek || 0) / 14) + 30 * cap(Math.log10(1 + (m?.avgReplies || 0)) / 2) + 20 * cap(Math.log10(1 + (m?.avgLikes || 0)) / 3.5));

export function addCategory(db, raw, auto = false) {
  const name = tagName(raw);
  if (!name || db.categories[name]) return null;
  db.categories[name] = { name, auto, addedAt: new Date().toISOString(), scannedAt: null, authors: {}, seen: [], fans: [], harvested: {} };
  return name;
}

// Whom the fans of one category comment on.
function fanTally(db, cat) {
  const map = new Map();
  const hours = Array(24).fill(0);
  let scanned = 0;
  for (const f of cat.fans) {
    const fan = db.fans[f];
    if (!fan) continue;
    scanned++;
    fan.hours.forEach((n, h) => { hours[h] += n; });
    for (const [to, n] of Object.entries(fan.targets)) {
      const x = map.get(to) || { fans: 0, comments: 0 };
      x.fans++;
      x.comments += n;
      map.set(to, x);
    }
  }
  return { map, hours, scanned };
}

// Tags the category's good authors post under, by number of authors.
function relatedTags(db, cat) {
  const counts = new Map();
  for (const u of Object.keys(cat.authors)) {
    const a = db.accounts[u];
    if (!good(a)) continue;
    for (const t of Object.keys(a.tags || {})) if (t !== cat.name) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, authors]) => ({ tag, authors }));
}

const row = (a, extra) => ({ username: a.username, fullName: a.fullName, followers: a.followers, avatar: a.avatar, verified: a.verified,
  postsPerWeek: a.metrics?.postsPerWeek ?? 0, avgLikes: a.metrics?.avgLikes ?? 0, avgReplies: a.metrics?.avgReplies ?? 0, lastPostAt: a.metrics?.lastPostAt ?? null,
  activeHours: a.metrics?.activeHours || [], funnel: a.funnel || [], score: catScore(a.metrics), ...extra });

// Everything the screen shows about the categories.
export function summary(db) {
  return Object.values(db.categories).map((cat) => {
    const tally = fanTally(db, cat);
    const top = Object.keys(cat.authors).map((u) => db.accounts[u]).filter(good)
      .map((a) => row(a, { fans: tally.map.get(a.username)?.fans || 0 })).sort((a, b) => b.score - a.score);
    const byFans = [...tally.map.entries()].map(([u, x]) => [db.accounts[u], x]).filter(([a]) => good(a))
      .map(([a, x]) => row(a, { fans: x.fans, fanComments: x.comments })).sort((a, b) => b.fans - a.fans || b.fanComments - a.fanComments);
    const pool = new Map([...top, ...byFans].map((r) => [r.username, r]));
    const peak = tally.hours.map((n, h) => [h, n]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
    return {
      name: cat.name, auto: cat.auto, exact: cat.exact !== false, scannedAt: cat.scannedAt, seenAuthors: Object.keys(cat.authors).length,
      top: top.slice(0, 200), byFans: byFans.slice(0, 200),
      postsPerDay: Math.round([...pool.values()].reduce((s, r) => s + r.postsPerWeek, 0) / 7),
      fansTotal: cat.fans.length, fansScanned: tally.scanned, fanHours: peak,
      related: relatedTags(db, cat).filter((r) => !db.categories[r.tag]).slice(0, 15),
    };
  });
}

export async function research({ emit, isStopped }) {
  const db = load();
  const s = db.settings;
  const log = (msg, level = 'info') => emit('log', { t: new Date().toISOString(), level, msg });
  const check = () => { if (isStopped()) throw new Stop(); };
  if (!Object.keys(db.categories).length) throw new Error('Добавьте хотя бы одну категорию');
  log('Открываю профиль AdsPower…');
  const session = await openSession(s, check);
  const t = session.t;
  let failures = 0;
  const doneNow = new Set();   // profiles already opened in this run
  const deadline = Date.now() + s.runMinutes * 60000;
  class TimeUp extends Error {}

  const step = async (label, fn) => {
    check();
    if (Date.now() > deadline) throw new TimeUp();
    try { const r = await fn(); failures = 0; return r; } catch (e) {
      if (e instanceof Stop || e instanceof Blocked || e instanceof TimeUp) throw e;
      log(`${label}: ${e.message.split('\n')[0]}`, 'warn');
      await t.dump(label);
      if (++failures >= 5) throw new Error('Пять ошибок подряд — останавливаюсь, чтобы не нагружать аккаунт. Скриншоты лежат в папке debug.');
      return null;
    }
  };

  // Open a profile and store its card. Returns the card, or null when the profile did not open.
  const evaluate = async (u) => {
    doneNow.add(u);
    const r = await step(`@${u}`, () => t.profile(u, { scrolls: s.profileScrolls }));
    if (!r) return null;
    const prev = db.accounts[u] || { username: u, foundAt: new Date().toISOString(), status: 'new', role: 'candidate' };
    if (!r.found) { db.accounts[u] = { ...prev, evaluatedAt: new Date().toISOString(), filterReason: 'профиль не открылся' }; return db.accounts[u]; }
    const usr = r.user;
    const tags = {};
    for (const p of r.posts) if (!p.isReply) for (const tg of p.tags || []) tags[tg] = (tags[tg] || 0) + 1;
    const acc = { ...prev,
      fullName: usr.full_name ?? prev.fullName ?? '', bio: usr.bio ?? prev.bio ?? '', links: usr.links ?? prev.links ?? [],
      followers: usr.followers ?? prev.followers ?? null, verified: usr.verified ?? prev.verified ?? false, private: usr.private ?? prev.private ?? false,
      metrics: metrics(r.posts, usr.followers ?? prev.followers), tags,
      topPosts: r.posts.filter((p) => !p.isReply && p.code).sort((a, b) => (b.replies ?? 0) - (a.replies ?? 0)).slice(0, 3)
        .map((p) => ({ code: p.code, text: p.text.slice(0, 280), likes: p.likes, replies: p.replies, takenAt: p.takenAt })),
      evaluatedAt: new Date().toISOString() };
    acc.femaleName = femaleNameHint(acc.fullName, u);
    acc.funnel = funnel(acc.links, acc.bio);
    acc.filterReason = filterReason(acc, s);
    if (acc.status === 'new' || acc.status === 'filtered') acc.status = acc.filterReason ? 'filtered' : 'new';
    if (usr.pic && usr.pic !== prev.picUrl) {
      const buf = await t.avatar(usr.pic);
      if (buf) { fs.mkdirSync(AVATARS, { recursive: true }); fs.writeFileSync(path.join(AVATARS, `${u}.jpg`), buf); acc.avatar = `${u}.jpg`; }
      acc.picUrl = usr.pic;
    }
    db.accounts[u] = acc;
    return acc;
  };

  // One round of work on one category; returns how many pages it opened.
  const round = async (cat) => {
    let did = 0;
    const phase = (what, done = 0, total = 0) => emit('progress', { phase: `Категория «${cat.name}»: ${what}`, done, total });

    if (!fresh(cat.scannedAt, 1)) {
      phase('читаю ленту');
      const res = await step(`категория ${cat.name}`, () => t.topic(cat.name, { scrolls: s.catScrolls, tagPath: s.tagPath, id: cat.tagId || db.tagIds[cat.name] }));
      if (res) {
        const posts = res.posts;
        Object.assign(db.tagIds, res.tagIds);
        cat.tagId = res.id;
        cat.exact = res.exact;
        if (!res.exact) log(`«${cat.name}»: такой темы в Threads не нашлось — взяты посты из поиска по слову. Точные названия тем видны во вкладке «Похожие».`, 'warn');
        const seen = new Set(cat.seen);
        for (const p of posts) {
          const key = p.code || `${p.username}:${p.takenAt}`;
          if (seen.has(key) || (s.englishOnly && isEnglish(p.text) === false)) continue;
          seen.add(key);
          const a = cat.authors[p.username] || { posts: 0, likes: 0, replies: 0 };
          a.posts++; a.likes += p.likes || 0; a.replies += p.replies || 0;
          cat.authors[p.username] = a;
        }
        // People posting in a category are its audience too, and so is everyone discussing its hottest posts.
        const fans = new Set(cat.fans);
        for (const p of posts) if (fans.size < s.catFans) fans.add(p.username);
        cat.fans = [...fans];
        const hot = new Map((cat.hot || []).map((h) => [h.code, h]));
        for (const p of posts) if (p.code && (p.replies || 0) >= 3) hot.set(p.code, { username: p.username, code: p.code, replies: p.replies });
        cat.hot = [...hot.values()].sort((a, b) => b.replies - a.replies).slice(0, 40);
        cat.seen = [...seen].slice(-3000);
        cat.scannedAt = new Date().toISOString();
        log(`«${cat.name}»: в ленте ${posts.length} постов, авторов всего ${Object.keys(cat.authors).length}`);
        did++;
      }
    }

    const goodAuthors = () => Object.keys(cat.authors).filter((u) => good(db.accounts[u]));
    if (goodAuthors().length < s.catAuthors) {
      const todo = Object.entries(cat.authors).filter(([u]) => !doneNow.has(u) && !fresh(db.accounts[u]?.evaluatedAt, s.reevalDays))
        .sort((a, b) => (b[1].replies + b[1].likes / 10) - (a[1].replies + a[1].likes / 10)).slice(0, s.catBatch);
      let i = 0;
      for (const [u] of todo) {
        phase('проверяю авторов', i++, todo.length);
        const acc = await evaluate(u);
        if (acc) { did++; log(`@${u}: ${acc.filterReason ? `отсеян — ${acc.filterReason}` : 'подходит'}`); }
      }
    }

    if (cat.fans.length < s.catFans) {
      const fans = new Set(cat.fans);
      const hot = (cat.hot || []).filter((h) => !cat.harvested[`post:${h.code}`]).slice(0, 4);
      for (const h of hot) {
        phase('собираю фанов под обсуждаемыми постами');
        const reps = await step(`@${h.username}/post/${h.code}`, () => t.replies(h.username, h.code, { scrolls: s.profileScrolls }));
        did++;
        for (const r of reps || []) if (fans.size < s.catFans && !(s.englishOnly && isEnglish(r.text) === false)) fans.add(r.username);
        cat.harvested[`post:${h.code}`] = true;
      }
      cat.fans = [...fans];
    }

    if (cat.fans.length < s.catFans) {
      const sources = goodAuthors().filter((u) => !cat.harvested[u])
        .sort((a, b) => catScore(db.accounts[b].metrics) - catScore(db.accounts[a].metrics)).slice(0, 3);
      const fans = new Set(cat.fans);
      for (const u of sources) {
        phase('собираю фанов');
        for (const p of (db.accounts[u].topPosts || []).slice(0, 2)) {
          const reps = await step(`@${u}/post/${p.code}`, () => t.replies(u, p.code, { scrolls: s.profileScrolls }));
          did++;
          for (const r of reps || []) {
            if (fans.size >= s.catFans) break;
            if (r.username !== u && !(s.englishOnly && isEnglish(r.text) === false)) fans.add(r.username);
          }
        }
        cat.harvested[u] = true;
      }
      if (sources.length) { cat.fans = [...fans]; log(`«${cat.name}»: фанов собрано ${cat.fans.length}`); }
    }

    const unread = cat.fans.filter((f) => !db.fans[f]).slice(0, s.fanBatch);
    let i = 0;
    for (const f of unread) {
      phase('смотрю, кого комментируют фаны', i++, unread.length);
      const res = await step(`комментарии @${f}`, () => t.comments(f, { scrolls: s.commentScrolls }));
      if (!res) continue;
      const fan = { scannedAt: new Date().toISOString(), targets: {}, hours: Array(24).fill(0), tags: {} };
      for (const c of res.list) {
        if (!c.to) continue;
        fan.targets[c.to] = (fan.targets[c.to] || 0) + 1;
        if (c.takenAt) fan.hours[new Date(c.takenAt * 1000).getUTCHours()]++;
        for (const tg of c.tags || []) fan.tags[tg] = (fan.tags[tg] || 0) + 1;
      }
      db.fans[f] = fan;
      did++;
    }

    // Authors the fans pay most attention to, even if the category feed never showed them.
    const tally = fanTally(db, cat);
    const fav = [...tally.map.entries()].filter(([u, x]) => x.fans >= 2 && !doneNow.has(u) && !fresh(db.accounts[u]?.evaluatedAt, s.reevalDays) && db.accounts[u]?.role !== 'scout')
      .sort((a, b) => b[1].fans - a[1].fans).slice(0, Math.ceil(s.catBatch / 2));
    i = 0;
    for (const [u] of fav) {
      phase('проверяю любимых авторов фанов', i++, fav.length);
      if (await evaluate(u)) did++;
    }
    save();
    emit('change', {});
    return did;
  };

  try {
    if (!(await t.loggedIn())) log('Похоже, в профиле не выполнен вход в Threads.', 'warn');
    for (;;) {
      let did = 0;
      for (const cat of Object.values(db.categories)) did += await round(cat);
      if (s.catExpand) {
        for (const cat of Object.values(db.categories)) {
          for (const r of relatedTags(db, cat)) {
            if (Object.keys(db.categories).length >= s.maxCategories || r.authors < s.catExpandMin) break;
            if (addCategory(db, r.tag, true)) { log(`Новая категория «${r.tag}» — её ставят ${r.authors} авторов из «${cat.name}»`); did++; }
          }
        }
        save();
        emit('change', {});
      }
      if (!did) break;
    }
    log('Готово: все категории собраны до заданных объёмов.');
  } catch (e) {
    if (!(e instanceof TimeUp)) throw e;
    log(`Время запуска (${s.runMinutes} мин) вышло. Собранное сохранено — следующий «Старт» продолжит с этого места.`);
  } finally {
    save();
    emit('change', {});
    await session.close();
  }
}
