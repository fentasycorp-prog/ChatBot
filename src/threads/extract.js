// Pure data helpers for the Threads parser: pull users and posts out of whatever
// JSON the site ships (embedded <script> blobs and GraphQL responses), and turn
// a list of posts into activity/engagement numbers. No browser code here.

export const newBag = () => ({ users: new Map(), posts: new Map(), parents: new Map() });

export const normName = (u) => String(u || '').trim().replace(/^.*threads\.(?:net|com)\//i, '').replace(/^@/, '')
  .split(/[/?#\s]/)[0].toLowerCase();

const USERNAME = /^[a-z0-9_.]{1,30}$/i;
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function isUser(o) {
  return typeof o.username === 'string' && USERNAME.test(o.username)
    && ('pk' in o || 'id' in o || 'full_name' in o || 'profile_pic_url' in o || 'follower_count' in o);
}

function isPost(o) {
  return o.user && typeof o.user === 'object' && typeof o.user.username === 'string'
    && (typeof o.code === 'string' || o.pk != null)
    && ('like_count' in o || 'caption' in o || 'text_post_app_info' in o);
}

function addUser(bag, o) {
  const key = o.username.toLowerCase();
  const u = bag.users.get(key) || { username: key };
  const set = (k, v) => { if (v != null && v !== '') u[k] = v; };
  set('full_name', typeof o.full_name === 'string' ? o.full_name : null);
  set('bio', typeof o.biography === 'string' ? o.biography : null);
  set('followers', numOrNull(o.follower_count));
  set('verified', typeof o.is_verified === 'boolean' ? o.is_verified : null);
  const priv = o.text_post_app_is_private ?? o.is_private;
  set('private', typeof priv === 'boolean' ? priv : null);
  const hd = Array.isArray(o.hd_profile_pic_versions) ? o.hd_profile_pic_versions.at(-1)?.url : null;
  set('pic', typeof (hd || o.profile_pic_url) === 'string' ? (hd || o.profile_pic_url) : null);
  if (Array.isArray(o.bio_links)) {
    const links = o.bio_links.map((l) => l && l.url).filter((x) => typeof x === 'string');
    if (links.length) u.links = links;
  }
  bag.users.set(key, u);
}

function addPost(bag, o, embedded) {
  const info = o.text_post_app_info && typeof o.text_post_app_info === 'object' ? o.text_post_app_info : {};
  const key = String(o.code || o.pk);
  const prev = bag.posts.get(key);
  const fragments = info.text_fragments?.fragments;
  const text = o.caption?.text
    ?? (Array.isArray(fragments) ? fragments.map((f) => f?.plaintext || '').join('') : '');
  const post = {
    code: typeof o.code === 'string' ? o.code : null,
    username: o.user.username.toLowerCase(),
    text: typeof text === 'string' ? text : '',
    likes: numOrNull(o.like_count),
    replies: numOrNull(info.direct_reply_count),
    reposts: numOrNull(info.repost_count),
    quotes: numOrNull(info.quote_count),
    takenAt: numOrNull(o.taken_at),
    isReply: Boolean(info.is_reply || info.reply_to_author),
    replyTo: typeof info.reply_to_author?.username === 'string' ? info.reply_to_author.username.toLowerCase() : null,
    media: Boolean(o.image_versions2?.candidates?.length || o.video_versions?.length || o.carousel_media?.length),
    // A post quoted or reposted inside another one: not part of the page's own list.
    embedded: prev ? prev.embedded && embedded : embedded,
  };
  bag.posts.set(key, post);
}

// Walk any JSON value and collect everything that looks like a user or a post.
export function harvest(root, bag) {
  const stack = [[root, false]];
  let budget = 400000;
  while (stack.length && budget-- > 0) {
    const [node, embedded] = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (const v of node) if (v && typeof v === 'object') stack.push([v, embedded]); continue; }
    if (isUser(node)) addUser(bag, node);
    if (isPost(node)) addPost(bag, node, embedded);
    // In a thread each item answers the one before it: remember whose post a reply sits under.
    if (Array.isArray(node.thread_items)) {
      let prev = null;
      for (const it of node.thread_items) {
        const p = it?.post;
        if (!p?.user || typeof p.user.username !== 'string') continue;
        if (prev && (p.code || p.pk != null)) bag.parents.set(String(p.code || p.pk), prev);
        prev = p.user.username.toLowerCase();
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') stack.push([v, embedded || k === 'share_info' || k === 'linked_inline_media']);
    }
  }
  return bag;
}

// Responses may carry an anti-hijacking prefix or several JSON documents, one per line.
export function parseLoose(text) {
  const t = String(text || '').replace(/^for\s*\(;;\);/, '').trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return [];
  try { return [JSON.parse(t)]; } catch { /* fall through to line mode */ }
  const out = [];
  for (const line of t.split('\n')) {
    try { out.push(JSON.parse(line)); } catch { /* not JSON */ }
  }
  return out;
}

// "12.3K followers", "1,204", "2,5 тыс." → number
export function parseCount(text) {
  const m = /(\d[\d.,\s ]*)\s*(k(?![a-z])|m(?![a-z])|b(?![a-z])|тыс|млн|млрд)?/i.exec(String(text || ''));
  if (!m) return null;
  const unit = (m[2] || '').toLowerCase();
  let raw = m[1].replace(/[\s ]/g, '');
  if (unit) raw = raw.replace(',', '.');
  else raw = raw.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.');
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, 'тыс': 1e3, m: 1e6, 'млн': 1e6, b: 1e9, 'млрд': 1e9 }[unit] || 1;
  return Math.round(n * mult);
}

const STOP = new Set(('the and you is to of in my a i it that for me so this with on be are not what just your have do like'
  + ' was im its dont can at all but he she they we if no yes how why when love good').split(' '));

// true / false / null (not enough text to tell)
export function isEnglish(text) {
  const t = String(text || '');
  const letters = t.match(/\p{L}/gu) || [];
  if (letters.length < 3) return null;
  const latin = letters.filter((c) => /[a-z]/i.test(c)).length / letters.length;
  if (latin < 0.7) return false;
  const words = t.toLowerCase().replace(/[’']/g, '').match(/[a-z]+/g) || [];
  if (words.length < 5) return null;
  return words.filter((w) => STOP.has(w)).length / words.length >= 0.1;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const DAY = 86400;

// Activity and engagement from the account's own (non-reply) posts.
export function metrics(posts, followers, nowSec = Date.now() / 1000) {
  const own = posts.filter((p) => !p.isReply && !p.embedded);
  const dated = own.filter((p) => p.takenAt).sort((a, b) => b.takenAt - a.takenAt);
  const recent = dated.filter((p) => nowSec - p.takenAt <= 30 * DAY);
  let postsPerWeek = 0;
  if (recent.length >= 2) {
    const spanDays = Math.max(1, (nowSec - recent.at(-1).takenAt) / DAY);
    postsPerWeek = (recent.length / spanDays) * 7;
  } else if (recent.length === 1) postsPerWeek = 7 / 30;
  const base = recent.length ? recent : own;
  const m = {
    postsSeen: own.length,
    postsPerWeek: Math.round(postsPerWeek * 10) / 10,
    avgLikes: Math.round(avg(base.map((p) => p.likes || 0))),
    avgReplies: Math.round(avg(base.map((p) => p.replies || 0)) * 10) / 10,
    avgReposts: Math.round(avg(base.map((p) => (p.reposts || 0) + (p.quotes || 0))) * 10) / 10,
    lastPostAt: dated[0]?.takenAt || null,
    english: isEnglish(base.map((p) => p.text).join(' . ')),
  };
  m.engagementRate = followers ? Math.round(((m.avgLikes + m.avgReplies + m.avgReposts) / followers) * 10000) / 100 : null;
  return m;
}

// A hint only: the first name in the display name is a common US female name.
const FEMALE = new Set(('emma olivia ava sophia isabella mia charlotte amelia harper evelyn abigail emily ella elizabeth camila luna sofia'
  + ' avery mila aria scarlett penelope layla chloe victoria madison eleanor grace nora riley zoey hannah hazel lily ellie violet'
  + ' lillian zoe stella aurora natalie emilia everly leah aubrey willow addison lucy audrey bella nova brooklyn paisley savannah'
  + ' claire skylar isla genesis naomi elena caroline eliana anna maya valentina ruby kennedy ivy ariana aaliyah cora madelyn alice'
  + ' kinsley hailey gabriella allison gianna serenity samantha sarah autumn quinn eva piper sophie sadie delilah josephine nevaeh'
  + ' adeline arya emery lydia clara vivian madeline peyton julia rylee brielle reagan natalia jade athena maria leilani everleigh'
  + ' liliana melanie mackenzie hadley raelynn kaylee rose arianna isabelle melody eliza lyla katherine aubree adalynn kylie faith'
  + ' mary margaret ximena iris alexandra jasmine charlie amaya taylor isabel ashley khloe ryleigh alexa amara valeria andrea parker'
  + ' norah eden elliana brianna emersyn valerie anastasia eloise jordyn morgan lauren jessica jennifer amanda stephanie nicole'
  + ' melissa rebecca rachel megan kayla brittany danielle kimberly amber tiffany heather michelle crystal kelly christina courtney'
  + ' lisa skye lola kate katie kat molly holly daisy summer sky mandy candy sasha tori bri brooke paige jenna jenny jess kelsey'
  + ' lexi lexie alexis alyssa sydney destiny haley kendall kylee carly cassie tessa gigi mimi nikki vicky bonnie bailey cherry'
  + ' angel angela angelina tina dana gina mila miley selena bianca bella elle ellie erin erica erika becca becky vanessa veronica'
  + ' carmen diana julie juliet june joy hope raven roxy ruby sara tara trinity whitney yasmin zara').split(' '));

export function femaleNameHint(fullName, username) {
  const first = (String(fullName || '').toLowerCase().match(/[a-z]+/) || [])[0];
  if (first && FEMALE.has(first)) return true;
  return String(username || '').toLowerCase().split(/[._\d]+/).some((part) => FEMALE.has(part));
}

// 0–100. Audience overlap weighs most: it is the "same niche" signal.
export function score({ overlap = 0, commentedBy, metrics: m, femaleName }) {
  const cap = (x) => Math.max(0, Math.min(1, x));
  const s = 40 * cap(((overlap || 0) + 2 * (commentedBy?.length || 0)) / 5)
    + 20 * cap((m?.postsPerWeek || 0) / 14)
    + 25 * cap(Math.log10(1 + (m?.avgReplies || 0)) / 2)
    + 10 * cap(Math.log10(1 + (m?.avgLikes || 0)) / 3)
    + (femaleName ? 5 : 0);
  return Math.round(s);
}

const LINK_KINDS = [[/onlyfans\.com/i, 'OnlyFans'], [/fansly\.com/i, 'Fansly'], [/fanvue\.com/i, 'Fanvue'], [/linktr\.ee|beacons\.ai|allmylinks|hoo\.be|bio\.site|link\.me|snipfeed|linkr\.bio|msha\.ke/i, 'мультиссылка'],
  [/t\.me|telegram/i, 'Telegram'], [/instagram\.com/i, 'Instagram'], [/tiktok\.com/i, 'TikTok'], [/(twitter|x)\.com/i, 'X'], [/youtube\.com|youtu\.be/i, 'YouTube'],
  [/snapchat\.com/i, 'Snapchat'], [/patreon\.com/i, 'Patreon'], [/throne\.com|amazon\.[a-z.]+\/.*wishlist/i, 'вишлист']];
const CTA = /link in (my )?bio|check (out )?my (bio|profile|page)|on my (page|profile)|dm me|message me|follow me|my bio/i;

// Where the author sends people: kinds of links in the bio.
export function funnel(links, bio) {
  const kinds = new Set();
  for (const l of [...(links || []), String(bio || '')]) for (const [re, kind] of LINK_KINDS) if (re.test(l)) kinds.add(kind);
  if (!kinds.size && (links || []).length) kinds.add('сайт');
  return [...kinds];
}

// How an author comments under other people's posts.
export function commentStats(comments, nowSec = Date.now() / 1000) {
  const week = comments.filter((c) => c.takenAt && nowSec - c.takenAt <= 7 * DAY);
  const norm = (c) => String(c.text || '').toLowerCase().replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim();
  const texts = comments.map(norm).filter((x) => x.split(' ').length >= 2);
  const seen = new Map();
  for (const x of texts) seen.set(x, (seen.get(x) || 0) + 1);
  const targets = new Map();
  for (const c of comments) if (c.to) targets.set(c.to, (targets.get(c.to) || 0) + 1);
  return {
    total: comments.length,
    perDay: Math.round((week.length / 7) * 10) / 10,
    // Share of comments whose text repeats word for word: a sign of templated commenting.
    templated: texts.length >= 4 ? Math.round((texts.filter((x) => seen.get(x) >= 2).length / texts.length) * 100) : null,
    cta: comments.length ? Math.round((comments.filter((c) => CTA.test(c.text || '')).length / comments.length) * 100) : null,
    targets: [...targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([to, count]) => ({ to, count })),
  };
}
