// Project storage: one folder per project under workspace/, state in project.json.
// Both the MCP server and the web server read/write these files, so every
// change is a short synchronous load-modify-save.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = path.resolve(process.env.STUDIO_HOME || path.join(ROOT, 'workspace'));

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(4).toString('hex')}`;

export function projDir(id) {
  if (!/^[a-z0-9_]+$/.test(String(id))) throw new Error(`Некорректный id проекта: ${id}`);
  return path.join(HOME, id);
}

export function listProjects() {
  if (!fs.existsSync(HOME)) return [];
  return fs.readdirSync(HOME)
    .filter((d) => fs.existsSync(path.join(HOME, d, 'project.json')))
    .map((d) => {
      const p = JSON.parse(fs.readFileSync(path.join(HOME, d, 'project.json'), 'utf8'));
      return { id: p.id, name: p.name, width: p.width, height: p.height, clips: p.clips.length, updatedAt: p.updatedAt };
    })
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function load(id) {
  const file = path.join(projDir(id), 'project.json');
  if (!fs.existsSync(file)) throw new Error(`Проект не найден: ${id}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function save(p) {
  const dir = projDir(p.id);
  for (const sub of ['media', 'thumbs', 'exports']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  p.updatedAt = new Date().toISOString();
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(p, null, 1));
  fs.renameSync(file + '.tmp', file);
  return p;
}

// Load, apply fn, append to the activity log, save. Returns fn's result.
export function mutate(id, ctx, action, fn) {
  const p = load(id);
  const result = fn(p);
  p.activity.push({ t: new Date().toISOString(), actor: ctx?.actor || 'agent', action, detail: result?.log || '' });
  if (p.activity.length > 200) p.activity = p.activity.slice(-200);
  save(p);
  return result;
}
