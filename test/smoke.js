// End-to-end check: drives the MCP server over stdio the way an agent would,
// on synthetic footage, and verifies the exported file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
const ff = (...args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);

// 8 s landscape clip: tone for 0–2 s and 4–6 s, silence in between and at the end.
const talk = path.join(tmp, 'talk.mp4');
ff('-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=440:d=8',
  '-af', "volume='if(lt(mod(t,4),2),1,0)':eval=frame", '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', talk);
const broll = path.join(tmp, 'broll.mp4');
ff('-f', 'lavfi', '-i', 'smptebars=s=640x360:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', broll);
const music = path.join(tmp, 'music.wav');
ff('-f', 'lavfi', '-i', 'sine=f=220:d=20', music);

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({
  command: 'node', args: ['src/mcp.js'], env: { ...process.env, STUDIO_HOME: path.join(tmp, 'ws') },
}));
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, `${name}: ${res.content[0].text}`);
  return { data: JSON.parse(res.content[0].text), content: res.content };
};

const tools = (await client.listTools()).tools.map((t) => t.name);
assert.ok(tools.includes('export_video'));

const { data: proj } = await call('create_project', { name: 'Тест', aspect: '9:16' });
const projectId = proj.id;
const m1 = (await call('import_media', { projectId, source: talk })).data;
const m2 = (await call('import_media', { projectId, source: broll })).data;
const m3 = (await call('import_media', { projectId, source: music })).data;
const bg = (await call('create_background', { projectId, color: '#101828', color2: '#7a2cf5' })).data;
assert.equal(m1.kind, 'video'); assert.equal(m3.kind, 'audio'); assert.equal(bg.kind, 'image');

const intro = (await call('add_clip', { projectId, mediaId: bg.id, out: 1.5, fadeOut: 0.3 })).data;
const main = (await call('add_clip', { projectId, mediaId: m1.id, fit: 'blur', zoom: 1, zoomTo: 1.15 })).data;
assert.equal(main.start, 1.5);

const cut = (await call('remove_silences', { projectId })).data;
assert.ok(cut.removedSeconds > 3 && cut.removedSeconds < 4.5, `removed ${cut.removedSeconds}s`);

await call('add_clip', { projectId, mediaId: m2.id, track: 'V2', start: 2.5, out: 1.2, fadeIn: 0.2 });
await call('add_clip', { projectId, mediaId: m3.id, volume: 0.2, out: cut.duration, fadeOut: 0.5 });
await call('add_texts', { projectId, texts: [
  { text: 'Привет! Это тест', start: 0, end: 1.5, preset: 'title' },
  { text: 'Субтитры с длинной строкой, которая должна перенестись на вторую строку', start: 1.6, end: 4, bg: 'black@0.5' },
] });

const tl = (await call('get_timeline', { projectId })).data;
const firstMain = tl.tracks.V1.find((c) => c.mediaId === m1.id);
const split = (await call('split_clip', { projectId, clipId: firstMain.id, at: firstMain.start + 1 })).data;
await call('update_clip', { projectId, clipId: split.right, zoom: 1.3, zoomTo: null });

const frame = await call('render_frame', { projectId, t: 2 });
assert.equal(frame.content[1].type, 'image');
fs.writeFileSync(path.join(tmp, 'frame.jpg'), Buffer.from(frame.content[1].data, 'base64'));

const out = (await call('export_video', { projectId, height: 960 })).data;
const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-of', 'json', '-show_streams', '-show_format', out.file]));
const v = info.streams.find((s) => s.codec_type === 'video');
assert.equal(v.width, 540); assert.equal(v.height, 960);
assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
assert.ok(Math.abs(Number(info.format.duration) - cut.duration) < 0.2, `duration ${info.format.duration} vs ${cut.duration}`);

await client.close();
console.log(`OK: ${tools.length} инструментов, экспорт ${out.duration}s, ${out.sizeMb} МБ`);
console.log(`Файлы теста: ${tmp}`);
