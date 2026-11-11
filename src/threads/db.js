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
  autoHours: [0, 0, 168],          // refresh tracked authors every N hours (0 = off)
  maxCandidates: [30, 1, 300],     // candidate profiles evaluated per run
  minOverlap: [2, 1, 50],          // how many scanned commenters must follow a candidate
  minFollowers: [3000, 0, 1e8],
  minPostsPerWeek: [3, 0, 500],
  minAvgReplies: [5, 0, 1e6],
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
    posts: raw.posts || [],         // our own published posts: { at, text, ok }
  };
  return db;
}

export function save() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 1));
  fs.renameSync(FILE + '.tmp', FILE);
}
