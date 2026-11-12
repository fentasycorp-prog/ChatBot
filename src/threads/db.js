// Parser state: one JSON file under workspace/threads-parser/ (never committed to git).
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from '../store.js';

export const DIR = path.resolve(process.env.THREADS_HOME || path.join(HOME, 'threads-parser'));
export const AVATARS = path.join(DIR, 'avatars');
export const DEBUG = path.join(DIR, 'debug');
const FILE = path.join(DIR, 'db.json');

// [default, min, max] for numbers
export const SETTING_SPEC = {
  adsUrl: 'http://local.adspower.net:50325',
  adsKey: '',
  adsProfile: '',
  tgToken: '',                     // Telegram bot token for new-post alerts
  tgChat: '',                      // chat id the alerts go to
  feedPath: '/following',
  tagPath: '/search?q={q}&serp_type=tags',   // page of a category (topic); {q} is its name
  catExpand: true,                 // add related categories found along the way          // the feed of accounts our profile follows
  threadsBase: 'https://www.threads.com',
  closeBrowser: true,
  englishOnly: true,
  keywords: [],
  postsPerSeed: [4, 1, 20],        // posts of each reference to open (the most commented ones)
  commentersPerPost: [15, 1, 100],
  maxAudience: [25, 1, 300],       // commenters whose following list is opened per run
  followingScrolls: [6, 0, 60],
  profileScrolls: [3, 0, 20],
  commentScrolls: [3, 0, 30],      // how far to scroll an author's Replies tab
  autoHours: [0, 0, 168],
  monitorEvery: [60, 5, 3600],     // on-duty mode: seconds between feed checks
  alertMaxAgeMin: [15, 1, 1440],   // alert only about posts younger than this
  profilesPerCycle: [2, 0, 20],    // base authors opened directly each cycle, in turn
  followPerRun: [15, 1, 100],      // accounts to follow per button press          // refresh tracked authors every N hours (0 = off)
  maxCandidates: [30, 1, 300],     // candidate profiles evaluated per run
  minOverlap: [2, 1, 50],
  catAuthors: [100, 1, 1000],      // authors wanted per category
  catFans: [500, 0, 5000],         // fans (commenters) studied per category
  maxCategories: [20, 1, 200],
  catExpandMin: [3, 2, 100],       // authors of a category that must use a tag before it becomes a category
  catScrolls: [8, 0, 60],
  runMinutes: [60, 5, 1440],       // a category run stops by itself after this long
  catBatch: [10, 1, 100],          // authors checked per category per round
  fanBatch: [20, 1, 200],          // fans read per category per round          // how many scanned commenters must follow a candidate
  minFollowers: [3000, 0, 1e8],
  minPostsPerWeek: [3, 0, 500],
  minAvgReplies: [5, 0, 1e6],
  minAvgLikes: [50, 0, 1e8],
  requireLink: false,
  autoFollow: true,                // the Start button also follows found authors, so their posts reach the feed
  rescanHours: [3, 1, 48],         // Start: re-read the scouts this often while on duty
  autoTrack: true,                 // authors that scouts comment under join the tracked base without manual approval
  minScoutComments: [1, 1, 100],   // scout comments under an author needed to consider her              // only accounts with a link in the bio
  scoutChecks: [20, 0, 100],        // most active commenters checked per run for being a mass commenter
  scoutMinPerDay: [8, 1, 1000],    // comments a day that make a commenter a scout
  delayMin: [2500, 0, 60000],      // pause between actions, ms
  delayMax: [6000, 0, 120000],
  rescanDays: [30, 0, 365],        // do not reopen the same commenter sooner than this
  reevalDays: [14, 0, 365],        // do not re-evaluate the same candidate sooner than this
};

export function cleanSettings(input, base = {}) {
  const out = {};
  for (const [k, spec] of Object.entries(SETTING_SPEC)) {
    const v = input?.[k] ?? base[k];
    if (Array.isArray(spec) && spec.length === 3 && typeof spec[0] === 'number') {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? Math.min(spec[2], Math.max(spec[1], n)) : spec[0];
    } else if (Array.isArray(spec)) {
      const list = Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/);
      out[k] = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))].slice(0, 30);
    } else if (typeof spec === 'boolean') out[k] = v == null ? spec : Boolean(v);
    else out[k] = v == null ? spec : String(v).trim();
  }
  if (out.delayMax < out.delayMin) out.delayMax = out.delayMin;
  return out;
}

let db;

export function load() {
  if (db) return db;
  let raw = {};
  if (fs.existsSync(FILE)) raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  db = {
    settings: cleanSettings(raw.settings),
    seeds: Array.isArray(raw.seeds) ? raw.seeds : [],
    accounts: raw.accounts || {},   // username → profile card (references and candidates)
    audience: raw.audience || {},   // username → { seeds, following, scannedAt }
    lastRun: raw.lastRun || null,
    lastWatchAt: raw.lastWatchAt || null,
    posts: raw.posts || [],
    categories: raw.categories || {},   // name → { authors seen in its feed, fans, related tags }
    fans: raw.fans || {},
    tagIds: raw.tagIds || {},           // topic name → Threads topic id               // username → whom they comment on, when, under which tags         // our own published posts: { at, text, ok }
  };
  return db;
}

export function save() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 1));
  fs.renameSync(FILE + '.tmp', FILE);
}
