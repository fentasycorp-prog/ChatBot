// Turns a project timeline into an ffmpeg filter graph and renders it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

export const VIDEO_TRACKS = ['V1', 'V2'];
export const AUDIO_TRACKS = ['A1', 'A2'];

export const clipDur = (c) => (c.out - c.in) / (c.speed || 1);
export const clipEnd = (c) => c.start + clipDur(c);
export function totalDuration(p) {
  return Math.max(0, ...p.clips.map(clipEnd), ...p.texts.map((t) => t.end));
}

const n = (x) => Number(x.toFixed(3));
const even = (x) => Math.max(2, 2 * Math.round(x / 2));

let fontCache;
function fontFile() {
  if (fontCache) return fontCache;
  if (process.env.STUDIO_FONT) return (fontCache = process.env.STUDIO_FONT);
  try {
    fontCache = execFileSync('fc-match', ['-f', '%{file}', 'sans:bold'], { encoding: 'utf8' }).trim();
  } catch { /* fc-match is optional */ }
  if (!fontCache || !fs.existsSync(fontCache)) {
    fontCache = [
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
      'C:/Windows/Fonts/arialbd.ttf',
    ].find((f) => fs.existsSync(f));
  }
  if (!fontCache) throw new Error('Не найден шрифт для титров. Укажите путь к .ttf в переменной STUDIO_FONT.');
  return fontCache;
}

export function run(bin, args, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (onProgress) {
        const m = [...String(d).matchAll(/out_time_ms=(\d+)/g)].pop();
        if (m) onProgress(Number(m[1]) / 1e6);
      }
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    child.on('error', (e) => reject(new Error(`Не удалось запустить ${bin}: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${bin} завершился с ошибкой:\n${err.slice(-1500)}`))));
  });
}

export async function probe(file) {
  const { out } = await run('ffprobe', ['-v', 'error', '-of', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(out);
  const v = info.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = info.streams.find((s) => s.codec_type === 'audio');
  const isImage = /\.(png|jpe?g|webp|bmp)$/i.test(file);
  const kind = isImage ? 'image' : v ? 'video' : a ? 'audio' : null;
  if (!kind) throw new Error('В файле нет ни видео, ни аудио');
  const rotated = Math.abs(Number(v?.side_data_list?.find((s) => s.rotation != null)?.rotation || 0)) % 180 === 90;
  return {
    kind,
    duration: kind === 'image' ? 0 : n(Number(info.format.duration || v?.duration || a?.duration || 0)),
    width: v ? (rotated ? v.height : v.width) : 0,
    height: v ? (rotated ? v.width : v.height) : 0,
    hasAudio: kind !== 'image' && !!a,
  };
}

// A copy of the project containing only what is visible in [t, t+d), moved to time 0.
function slice(p, t, d) {
  const clips = p.clips.filter((c) => c.start <= t && clipEnd(c) > t).map((c) => {
    const sp = c.speed || 1;
    const k = (t - c.start) / clipDur(c);
    const z0 = c.zoom || 1, z1 = c.zoomTo ?? z0;
    const media = p.media.find((m) => m.id === c.mediaId);
    const inn = media.kind === 'image' ? 0 : c.in + (t - c.start) * sp;
    return { ...c, start: 0, in: inn, out: inn + d * sp, zoom: z0 + (z1 - z0) * k, zoomTo: undefined, fadeIn: 0, fadeOut: 0 };
  });
  const texts = p.texts.filter((x) => x.start <= t && x.end > t).map((x) => ({ ...x, start: 0, end: d }));
  return { ...p, clips, texts };
}

function wrap(text, maxChars) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && (line + ' ' + word).length > maxChars) { lines.push(line); line = word; }
      else line = line ? line + ' ' + word : word;
    }
    lines.push(line);
  }
  return lines.filter(Boolean);
}

const color = (c, fallback) => {
  const s = String(c || fallback);
  if (!/^(#[0-9a-f]{6}|[a-z]+)(@[0-9.]+)?$/i.test(s)) throw new Error(`Некорректный цвет: ${s}`);
  return s.replace(/^#/, '0x');
};

export const TEXT_PRESETS = {
  caption: { position: 'bottom', size: 0.042, color: 'white', bg: null },
  title: { position: 'center', size: 0.07, color: 'white', bg: null },
  label: { position: 'top', size: 0.035, color: 'white', bg: 'black@0.55' },
};

function build(p, { W, H, tmp, duration, noAudio }) {
  const fps = p.fps;
  const args = ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${n(duration)}`,
    '-f', 'lavfi', '-t', String(n(duration)), '-i', 'anullsrc=r=48000:cl=stereo'];
  const filters = [];
  const audio = ['[1:a]'];
  let idx = 2, last = '[0:v]', k = 0;

  const order = [...VIDEO_TRACKS, ...AUDIO_TRACKS];
  const clips = [...p.clips].sort((a, b) => order.indexOf(a.track) - order.indexOf(b.track) || a.start - b.start);

  for (const c of clips) {
    const media = p.media.find((m) => m.id === c.mediaId);
    if (!media) throw new Error(`Клип ${c.id} ссылается на отсутствующий файл ${c.mediaId}`);
    if (!fs.existsSync(media.path)) throw new Error(`Файл не найден на диске: ${media.path}`);
    const sp = c.speed || 1, d = clipDur(c), visual = VIDEO_TRACKS.includes(c.track) && media.kind !== 'audio';
    const wantAudio = !noAudio && media.hasAudio && (c.volume ?? 1) > 0;
    if (!visual && !wantAudio) continue;

    if (media.kind === 'image') args.push('-loop', '1', '-framerate', String(fps), '-t', String(n(d)), '-i', media.path);
    else args.push('-ss', String(n(c.in)), '-t', String(n(c.out - c.in)), '-i', media.path);
    const i = idx++;
    const fi = Math.min(c.fadeIn || 0, d / 2), fo = Math.min(c.fadeOut || 0, d / 2);

    if (visual) {
      const z0 = c.zoom || 1, z1 = c.zoomTo ?? z0;
      const chain = [`setpts=(PTS-STARTPTS)/${sp}`, `fps=${fps}`];
      if (c.fit === 'blur') {
        filters.push(`[${i}:v]${chain.join(',')},split[bg${k}][fg${k}]`,
          `[bg${k}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2[bgb${k}]`,
          `[fg${k}]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fgs${k}]`);
        chain.length = 0;
        chain.push(`[bgb${k}][fgs${k}]overlay=(W-w)/2:(H-h)/2`);
      } else if (c.fit === 'contain') {
        chain.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`);
      } else {
        chain.push(`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`);
      }
      if (z0 !== z1) {
        const z = `(${z0}+(${z1 - z0})*min(t/${n(d)},1))`;
        chain.push(`scale=w='2*trunc(${W}*${z}/2)':h='2*trunc(${H}*${z}/2)':eval=frame`, `crop=${W}:${H}`);
      } else if (z0 !== 1) {
        chain.push(`scale=${even(W * z0)}:${even(H * z0)}`, `crop=${W}:${H}`);
      }
      chain.push('setsar=1');
      if (fi || fo) chain.push('format=yuva420p');
      if (fi) chain.push(`fade=t=in:st=0:d=${n(fi)}:alpha=1`);
      if (fo) chain.push(`fade=t=out:st=${n(d - fo)}:d=${n(fo)}:alpha=1`);
      chain.push(`setpts=PTS+${n(c.start)}/TB`);
      const head = chain[0].startsWith('[') ? '' : `[${i}:v]`;
      filters.push(`${head}${chain.join(',')}[v${k}]`,
        `${last}[v${k}]overlay=eof_action=pass:enable='between(t,${n(c.start)},${n(c.start + d)})'[b${k}]`);
      last = `[b${k}]`;
    }
    if (wantAudio) {
      const chain = ['asetpts=PTS-STARTPTS'];
      if (sp !== 1) chain.push(`atempo=${sp}`);
      chain.push(`volume=${c.volume ?? 1}`);
      if (fi) chain.push(`afade=t=in:st=0:d=${n(fi)}`);
      if (fo) chain.push(`afade=t=out:st=${n(d - fo)}:d=${n(fo)}`);
      chain.push('aresample=48000', 'aformat=channel_layouts=stereo', `adelay=${Math.round(c.start * 1000)}:all=1`);
      filters.push(`[${i}:a]${chain.join(',')}[a${k}]`);
      audio.push(`[a${k}]`);
    }
    k++;
  }

  const font = fontFile();
  const draws = [];
  p.texts.forEach((t, ti) => {
    const size = Math.round((t.size || 0.042) * H);
    const lines = wrap(t.text, Math.max(6, Math.floor((W * 0.88) / (size * 0.6))));
    const lineH = Math.round(size * 1.3);
    const cy = (t.y ?? { top: 0.13, center: 0.5, bottom: W > H ? 0.84 : 0.74 }[t.position || 'bottom']) * H;
    lines.forEach((line, li) => {
      const file = path.join(tmp, `t${ti}_${li}.txt`);
      fs.writeFileSync(file, line);
      const y = Math.round(cy - (lines.length * lineH) / 2 + li * lineH);
      let d = `drawtext=fontfile='${font}':textfile='${file}':fontsize=${size}:fontcolor=${color(t.color, 'white')}` +
        `:borderw=${Math.max(2, Math.round(size / 12))}:bordercolor=black:x=(w-text_w)/2:y=${y}` +
        `:enable='between(t,${n(t.start)},${n(t.end)})'`;
      if (t.bg) d += `:box=1:boxcolor=${color(t.bg)}:boxborderw=${Math.round(size / 3)}`;
      draws.push(d);
    });
  });
  filters.push(`${last}${draws.length ? draws.join(',') : 'null'}[vout]`);
  if (!noAudio) filters.push(`${audio.join('')}amix=inputs=${audio.length}:normalize=0:duration=first[aout]`);

  const script = path.join(tmp, 'graph.txt');
  fs.writeFileSync(script, filters.join(';\n'));
  return [...args, '-filter_complex_script', script];
}

function size(p, height) {
  if (!height || height >= p.height) return { W: p.width, H: p.height };
  return { W: even((p.width * height) / p.height), H: even(height) };
}

async function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-'));
  try { return await fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export async function renderVideo(p, outFile, { height, crf = 20, onProgress } = {}) {
  const duration = totalDuration(p);
  if (duration <= 0) throw new Error('Таймлайн пуст — нечего экспортировать');
  return withTmp(async (tmp) => {
    const args = build(p, { ...size(p, height), tmp, duration });
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', ...args,
      '-map', '[vout]', '-map', '[aout]', '-t', String(n(duration)),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outFile],
    { onProgress: onProgress && ((t) => onProgress(Math.min(1, t / duration))) });
    return { file: outFile, duration: n(duration) };
  });
}

export async function renderFrame(p, t, outFile, { height = 720 } = {}) {
  const sub = slice(p, t, 1 / p.fps);
  return withTmp(async (tmp) => {
    const args = build(sub, { ...size(p, height), tmp, duration: 2 / p.fps, noAudio: true });
    await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args,
      '-map', '[vout]', '-frames:v', '1', '-update', '1', '-q:v', '4', outFile]);
    return outFile;
  });
}

// Silent ranges of a source file between `from` and `to` (source seconds).
export async function detectSilence(file, from, to, { noiseDb = -32, minSilence = 0.45 } = {}) {
  const { err } = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(to - from), '-i', file,
    '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, '-f', 'null', '-']);
  const ranges = [];
  let start = null;
  for (const m of err.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    if (m[1] === 'start') start = Math.max(0, Number(m[2]));
    else if (start != null) { ranges.push([from + start, from + Number(m[2])]); start = null; }
  }
  if (start != null) ranges.push([from + start, to]);
  return ranges;
}

export async function makeThumb(file, kind, duration, outFile) {
  const seek = kind === 'video' ? ['-ss', String(Math.min(0.5, duration / 2))] : [];
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...seek, '-i', file, '-frames:v', '1', '-update', '1',
    '-vf', 'scale=320:-2', outFile]);
}

export async function makeBackground(outFile, W, H, c1, c2) {
  const src = (c) => ['-f', 'lavfi', '-i', `color=c=${color(c)}:s=${W}x${H},format=gbrp`];
  // Two colours → vertical gradient from c1 (top) to c2 (bottom).
  const mix = c2 ? [...src(c2), '-filter_complex', "[0][1]blend=all_expr='A*(1-Y/H)+B*Y/H'"] : [];
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...src(c1), ...mix, '-frames:v', '1', '-update', '1', outFile]);
}
