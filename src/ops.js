// Editing operations. The same list backs the MCP tools (agent) and the web UI (user).
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HOME, newId, projDir, listProjects, load, save, mutate } from './store.js';
import {
  VIDEO_TRACKS, AUDIO_TRACKS, TEXT_PRESETS, clipDur, clipEnd, totalDuration,
  probe, renderVideo, renderFrame, detectSilence, makeThumb, makeBackground,
} from './render.js';

const TRACKS = [...VIDEO_TRACKS, ...AUDIO_TRACKS];
const ASPECTS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350] };
const r3 = (x) => Number(Number(x).toFixed(3));
const safeName = (s) => String(s).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'file';

function num(v, name, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Параметр ${name} должен быть числом от ${min} до ${max}`);
  }
  return v;
}
const find = (list, id, what) => {
  const item = list.find((x) => x.id === id);
  if (!item) throw new Error(`${what} не найден: ${id}`);
  return item;
};
const trackEnd = (p, track) => Math.max(0, ...p.clips.filter((c) => c.track === track).map(clipEnd));

const CLIP_PROPS = {
  start: [0, 36000], in: [0, 36000], out: [0, 36000], speed: [0.5, 2], volume: [0, 4],
  zoom: [1, 4], zoomTo: [1, 4], fadeIn: [0, 10], fadeOut: [0, 10],
};
function applyClipProps(p, c, a) {
  for (const [key, [min, max]] of Object.entries(CLIP_PROPS)) {
    if (a[key] === null && key === 'zoomTo') delete c.zoomTo;
    else if (a[key] != null) c[key] = r3(num(a[key], key, min, max));
  }
  if (a.fit != null) {
    if (!['cover', 'contain', 'blur'].includes(a.fit)) throw new Error('fit: cover, contain или blur');
    c.fit = a.fit;
  }
  if (a.track != null) {
    if (!TRACKS.includes(a.track)) throw new Error(`Дорожка должна быть одной из: ${TRACKS.join(', ')}`);
    c.track = a.track;
  }
  const media = find(p.media, c.mediaId, 'Файл');
  if (media.kind !== 'image') c.out = Math.min(c.out, media.duration);
  if (media.kind === 'audio' && VIDEO_TRACKS.includes(c.track)) throw new Error('Аудио можно класть только на дорожки A1/A2');
  if (media.kind === 'image' && AUDIO_TRACKS.includes(c.track)) throw new Error('Картинку можно класть только на дорожки V1/V2');
  if (c.out - c.in < 0.04) throw new Error('Клип получается короче одного кадра (проверьте in/out)');
}

function applyTextProps(t, a) {
  const preset = TEXT_PRESETS[a.preset];
  if (a.preset && !preset) throw new Error(`preset: ${Object.keys(TEXT_PRESETS).join(', ')}`);
  Object.assign(t, preset);
  if (a.text != null) t.text = String(a.text).slice(0, 500);
  if (a.start != null) t.start = r3(num(a.start, 'start', 0, 36000));
  if (a.end != null) t.end = r3(num(a.end, 'end', 0, 36000));
  if (a.position != null) {
    if (!['top', 'center', 'bottom'].includes(a.position)) throw new Error('position: top, center или bottom');
    t.position = a.position;
  }
  if (a.size != null) t.size = num(a.size, 'size', 0.015, 0.2);
  if (a.y !== undefined) { if (a.y === null) delete t.y; else t.y = num(a.y, 'y', 0, 1); }
  if (a.color != null) t.color = String(a.color);
  if (a.bg !== undefined) t.bg = a.bg ? String(a.bg) : null;
  if (!t.text?.trim()) throw new Error('Пустой текст');
  if (!(t.end > t.start)) throw new Error('end должен быть больше start');
}

function view(p) {
  const row = (c) => ({ ...c, end: r3(clipEnd(c)), file: p.media.find((m) => m.id === c.mediaId)?.name });
  return {
    id: p.id, name: p.name, width: p.width, height: p.height, fps: p.fps, duration: r3(totalDuration(p)),
    media: p.media.map(({ path: _path, ...m }) => m),
    tracks: Object.fromEntries(TRACKS.map((t) => [t, p.clips.filter((c) => c.track === t).sort((a, b) => a.start - b.start).map(row)])),
    texts: [...p.texts].sort((a, b) => a.start - b.start),
  };
}

async function registerMedia(projectId, file, name, ctx) {
  const info = await probe(file);
  const id = newId('m');
  let thumb = null;
  if (info.kind !== 'audio') {
    thumb = `${id}.jpg`;
    await makeThumb(file, info.kind, info.duration, path.join(projDir(projectId), 'thumbs', thumb));
  }
  const media = { id, name, path: file, thumb, ...info };
  mutate(projectId, ctx, 'import_media', (p) => { p.media.push(media); return { log: name }; });
  const { path: _path, ...pub } = media;
  return pub;
}

const P = { projectId: { type: 'string', description: 'id проекта' } };
const clipProps = {
  start: { type: 'number', description: 'Позиция на таймлайне, сек' },
  in: { type: 'number', description: 'Начало фрагмента в исходном файле, сек' },
  out: { type: 'number', description: 'Конец фрагмента в исходном файле, сек (для картинки — её длительность)' },
  track: { type: 'string', enum: TRACKS, description: 'V1 — основной видеоряд, V2 — перебивки поверх V1, A1/A2 — музыка и звук' },
  fit: { type: 'string', enum: ['cover', 'contain', 'blur'], description: 'cover — заполнить кадр с обрезкой, contain — вписать с полями, blur — вписать на размытом фоне' },
  zoom: { type: 'number', description: 'Увеличение кадра, 1–4' },
  zoomTo: { type: ['number', 'null'], description: 'Если задано — плавный наезд от zoom до zoomTo за время клипа; null — убрать' },
  speed: { type: 'number', description: 'Скорость 0.5–2' },
  volume: { type: 'number', description: 'Громкость 0–4 (0 — без звука)' },
  fadeIn: { type: 'number', description: 'Плавное появление, сек' },
  fadeOut: { type: 'number', description: 'Плавное исчезновение, сек' },
};
const textProps = {
  text: { type: 'string' },
  start: { type: 'number', description: 'Появление, сек' },
  end: { type: 'number', description: 'Исчезновение, сек' },
  preset: { type: 'string', enum: Object.keys(TEXT_PRESETS), description: 'caption — субтитр внизу, title — крупный заголовок по центру, label — плашка сверху' },
  position: { type: 'string', enum: ['top', 'center', 'bottom'] },
  size: { type: 'number', description: 'Высота шрифта в долях высоты кадра, напр. 0.045' },
  y: { type: ['number', 'null'], description: 'Точная вертикальная позиция центра текста, 0–1' },
  color: { type: 'string', description: 'Цвет: white, yellow, #FFD400…' },
  bg: { type: ['string', 'null'], description: 'Цвет подложки, напр. black@0.55; null — без подложки' },
};
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const ops = [
  {
    name: 'create_project',
    description: 'Создать новый видеопроект. Формат кадра: 9:16 (Reels/Shorts/TikTok), 16:9 (YouTube), 1:1, 4:5.',
    schema: obj({ name: { type: 'string' }, aspect: { type: 'string', enum: Object.keys(ASPECTS) }, fps: { type: 'number' } }, ['name']),
    async run(a, ctx) {
      const [width, height] = ASPECTS[a.aspect || '9:16'] || (() => { throw new Error('Неизвестный формат кадра'); })();
      const p = {
        id: newId('p'), name: String(a.name).slice(0, 100), width, height, fps: a.fps ? num(a.fps, 'fps', 12, 60) : 30,
        media: [], clips: [], texts: [],
        activity: [{ t: new Date().toISOString(), actor: ctx?.actor || 'agent', action: 'create_project', detail: a.name }],
      };
      save(p);
      return view(p);
    },
  },
  {
    name: 'list_projects',
    description: 'Список всех проектов.',
    schema: obj({}),
    async run() { return listProjects(); },
  },
  {
    name: 'get_timeline',
    description: 'Полное состояние проекта: файлы в медиатеке, клипы по дорожкам, тексты, общая длительность.',
    schema: obj(P, ['projectId']),
    async run(a) { return view(load(a.projectId)); },
  },
  {
    name: 'import_media',
    description: 'Добавить в медиатеку видео, картинку или аудио: путь к файлу на этом компьютере либо ссылка https://.',
    schema: obj({ ...P, source: { type: 'string', description: 'Абсолютный путь или URL' }, name: { type: 'string' } }, ['projectId', 'source']),
    async run(a, ctx) {
      load(a.projectId);
      let file = a.source;
      if (/^https?:\/\//i.test(a.source)) {
        const url = new URL(a.source);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Не удалось скачать: HTTP ${res.status}`);
        file = path.join(projDir(a.projectId), 'media', `${newId('dl')}_${safeName(path.basename(url.pathname))}`);
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
      } else {
        file = path.resolve(file);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Файл не найден: ${file}`);
      }
      return registerMedia(a.projectId, file, a.name || path.basename(file), ctx);
    },
  },
  {
    name: 'create_background',
    description: 'Сгенерировать фон-картинку (сплошной цвет или градиент) под размер кадра и добавить в медиатеку — для титульных карточек, заставок, слайдов с текстом.',
    schema: obj({ ...P, color: { type: 'string', description: 'Напр. #101828' }, color2: { type: 'string', description: 'Второй цвет для градиента' }, name: { type: 'string' } }, ['projectId', 'color']),
    async run(a, ctx) {
      const p = load(a.projectId);
      const file = path.join(projDir(p.id), 'media', `${newId('bg')}.png`);
      await makeBackground(file, p.width, p.height, a.color, a.color2);
      return registerMedia(p.id, file, a.name || `Фон ${a.color}${a.color2 ? '→' + a.color2 : ''}`, ctx);
    },
  },
  {
    name: 'add_clip',
    description: 'Положить файл из медиатеки на таймлайн. Без start клип встаёт в конец дорожки. in/out вырезают фрагмент исходника. Для картинки длительность задаётся через out (по умолчанию 3 сек).',
    schema: obj({ ...P, mediaId: { type: 'string' }, ...clipProps }, ['projectId', 'mediaId']),
    async run(a, ctx) {
      return mutate(a.projectId, ctx, 'add_clip', (p) => {
        const media = find(p.media, a.mediaId, 'Файл');
        const track = a.track || (media.kind === 'audio' ? 'A1' : 'V1');
        const c = {
          id: newId('c'), mediaId: media.id, track, start: 0, in: 0,
          out: media.kind === 'image' ? 3 : media.duration,
          speed: 1, volume: track === 'V2' ? 0 : 1, zoom: 1, fit: 'cover', fadeIn: 0, fadeOut: 0,
        };
        applyClipProps(p, c, { ...a, track });
        if (a.start == null) c.start = r3(trackEnd(p, track));
        p.clips.push(c);
        return { ...c, end: r3(clipEnd(c)), log: `${media.name} → ${track} @ ${c.start}s` };
      });
    },
  },
  {
    name: 'update_clip',
    description: 'Изменить клип: подрезать (in/out), передвинуть (start), перенести на другую дорожку, зум/наезд, скорость, громкость, фейды.',
    schema: obj({ ...P, clipId: { type: 'string' }, ...clipProps }, ['projectId', 'clipId']),
    async run(a, ctx) {
      return mutate(a.projectId, ctx, 'update_clip', (p) => {
        const c = find(p.clips, a.clipId, 'Клип');
        applyClipProps(p, c, a);
        const { projectId: _p, clipId: _c, ...changed } = a;
        return { ...c, end: r3(clipEnd(c)), log: `${c.id}: ${JSON.stringify(changed)}` };
      });
    },
  },
  {
    name: 'split_clip',
    description: 'Разрезать клип на два в указанный момент таймлайна.',
    schema: obj({ ...P, clipId: { type: 'string' }, at: { type: 'number', description: 'Время на таймлайне, сек' } }, ['projectId', 'clipId', 'at']),
    async run(a, ctx) {
      return mutate(a.projectId, ctx, 'split_clip', (p) => {
        const c = find(p.clips, a.clipId, 'Клип');
        if (!(a.at > c.start + 0.04 && a.at < clipEnd(c) - 0.04)) throw new Error(`Точка разреза должна быть внутри клипа (${c.start}–${r3(clipEnd(c))} сек)`);
        const isImage = find(p.media, c.mediaId, 'Файл').kind === 'image';
        const cut = r3(c.in + (a.at - c.start) * (c.speed || 1));
        const right = { ...c, id: newId('c'), start: r3(a.at), in: isImage ? 0 : cut, out: isImage ? r3(c.out - cut) : c.out, fadeIn: 0 };
        c.out = cut; c.fadeOut = 0;
        p.clips.push(right);
        return { left: c.id, right: right.id, log: `${c.id} @ ${a.at}s` };
      });
    },
  },
  {
    name: 'remove_clip',
    description: 'Удалить клип. ripple=true сдвигает всё, что правее, влево на длину удалённого клипа (без дыры).',
    schema: obj({ ...P, clipId: { type: 'string' }, ripple: { type: 'boolean' } }, ['projectId', 'clipId']),
    async run(a, ctx) {
      return mutate(a.projectId, ctx, 'remove_clip', (p) => {
        const c = find(p.clips, a.clipId, 'Клип');
        const end = clipEnd(c), d = clipDur(c);
        p.clips = p.clips.filter((x) => x !== c);
        if (a.ripple) {
          for (const x of p.clips) if (x.start >= end - 0.001) x.start = r3(x.start - d);
          for (const t of p.texts) if (t.start >= end - 0.001) { t.start = r3(t.start - d); t.end = r3(t.end - d); }
        }
        return { removed: c.id, log: c.id + (a.ripple ? ' (со сдвигом)' : '') };
      });
    },
  },
  {
    name: 'remove_silences',
    description: 'Автомонтаж: найти паузы в речи и вырезать их, сдвинув остальное. Без clipId обрабатывает все клипы на V1.',
    schema: obj({
      ...P, clipId: { type: 'string' },
      noiseDb: { type: 'number', description: 'Порог тишины в дБ, по умолчанию -32' },
      minSilence: { type: 'number', description: 'Минимальная длина паузы, сек, по умолчанию 0.45' },
      padding: { type: 'number', description: 'Сколько тишины оставить по краям фраз, сек, по умолчанию 0.1' },
    }, ['projectId']),
    async run(a, ctx) {
      const p0 = load(a.projectId);
      const pad = a.padding ?? 0.1;
      const targets = (a.clipId ? [find(p0.clips, a.clipId, 'Клип')] : p0.clips.filter((c) => c.track === 'V1'))
        .filter((c) => p0.media.find((m) => m.id === c.mediaId)?.hasAudio);
      const plans = [];
      for (const c of targets) {
        const media = p0.media.find((m) => m.id === c.mediaId);
        const silent = await detectSilence(media.path, c.in, c.out, { noiseDb: a.noiseDb, minSilence: a.minSilence });
        const keep = [];
        let pos = c.in;
        for (const [s, e] of silent) {
          const cutFrom = s === c.in ? s : s + pad, cutTo = e >= c.out ? e : e - pad;
          if (cutTo - cutFrom < 0.05) continue;
          if (cutFrom - pos > 0.08) keep.push([pos, cutFrom]);
          pos = cutTo;
        }
        if (c.out - pos > 0.08) keep.push([pos, c.out]);
        if (keep.length && !(keep.length === 1 && keep[0][0] === c.in && keep[0][1] === c.out)) plans.push({ id: c.id, keep });
      }
      return mutate(a.projectId, ctx, 'remove_silences', (p) => {
        let removed = 0, pieces = 0;
        // Right-to-left so earlier ripples don't move clips still waiting to be processed.
        const todo = plans.map((pl) => ({ ...pl, c: p.clips.find((x) => x.id === pl.id) })).filter((x) => x.c)
          .sort((x, y) => y.c.start - x.c.start);
        for (const { c, keep } of todo) {
          const sp = c.speed || 1, oldEnd = clipEnd(c);
          let t = c.start;
          const parts = keep.map(([i, o], k) => {
            const part = { ...c, id: k === 0 ? c.id : newId('c'), start: r3(t), in: r3(i), out: r3(o), fadeIn: k === 0 ? c.fadeIn : 0, fadeOut: k === keep.length - 1 ? c.fadeOut : 0 };
            t += (o - i) / sp;
            return part;
          });
          const shift = oldEnd - t;
          p.clips = p.clips.filter((x) => x !== c);
          for (const x of p.clips) if (x.start >= oldEnd - 0.001) x.start = r3(x.start - shift);
          for (const x of p.texts) if (x.start >= oldEnd - 0.001) { x.start = r3(x.start - shift); x.end = r3(x.end - shift); }
          p.clips.push(...parts);
          removed += shift; pieces += parts.length;
        }
        return { clipsProcessed: todo.length, pieces, removedSeconds: r3(removed), duration: r3(totalDuration(p)), log: `вырезано ${r3(removed)}s пауз, ${pieces} фрагментов` };
      });
    },
  },
  {
    name: 'add_texts',
    description: 'Добавить тексты на экран: субтитры, заголовки, плашки. Принимает сразу список — удобно для субтитров ко всему ролику.',
    schema: obj({ ...P, texts: { type: 'array', items: obj(textProps, ['text', 'start', 'end']), minItems: 1 } }, ['projectId', 'texts']),
    async run(a, ctx) {
      return mutate(a.projectId, ctx, 'add_texts', (p) => {
        const added = a.texts.map((src) => {
          const t = { id: newId('t'), ...TEXT_PRESETS.caption };
          applyTextProps(t, { preset: 'caption', ...src });
          return t;
        });
        p.texts.push(...added);
        return { added, log: `${added.length} шт.` };
      });
    },
  },
  {
    name: 'update_text',
    description: 'Изменить текст на экране: содержание, время, позицию, размер, цвет.',
    schema: obj({ ...P, textId: { type: 'string' }, ...textProps }, ['projectId', 'textId']),
    async run(a, ctx) {
      return mutate(a.projectId, ctx, 'update_text', (p) => {
        const t = find(p.texts, a.textId, 'Текст');
        applyTextProps(t, a);
        return { ...t, log: t.id };
      });
    },
  },
  {
    name: 'remove_texts',
    description: 'Удалить тексты по списку id; all=true удаляет все тексты проекта.',
    schema: obj({ ...P, textIds: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' } }, ['projectId']),
    async run(a, ctx) {
      return mutate(a.projectId, ctx, 'remove_texts', (p) => {
        const before = p.texts.length;
        p.texts = a.all ? [] : p.texts.filter((t) => !(a.textIds || []).includes(t.id));
        return { removed: before - p.texts.length, log: `${before - p.texts.length} шт.` };
      });
    },
  },
  {
    name: 'render_frame',
    description: 'Отрендерить один кадр таймлайна и вернуть его картинкой — чтобы посмотреть глазами, как выглядит монтаж (кадрирование, тексты) в нужный момент.',
    schema: obj({ ...P, t: { type: 'number', description: 'Время на таймлайне, сек' } }, ['projectId', 't']),
    async run(a) {
      const p = load(a.projectId);
      const t = num(a.t, 't', 0, Math.max(0, totalDuration(p)));
      const file = path.join(projDir(p.id), 'thumbs', 'frame.jpg');
      await renderFrame(p, t, file);
      return { image: file, t };
    },
  },
  {
    name: 'export_video',
    description: 'Собрать итоговый MP4 (H.264 + AAC). height уменьшает разрешение для быстрого черновика (напр. 720).',
    schema: obj({ ...P, name: { type: 'string' }, height: { type: 'number' }, crf: { type: 'number', description: 'Качество 16–30, меньше — лучше; по умолчанию 20' } }, ['projectId']),
    async run(a, ctx) {
      const p = load(a.projectId);
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const fileName = `${safeName(a.name || p.name)}_${stamp}.mp4`;
      const file = path.join(projDir(p.id), 'exports', fileName);
      const res = await renderVideo(p, file, {
        height: a.height ? num(a.height, 'height', 144, 4320) : undefined,
        crf: a.crf ? num(a.crf, 'crf', 10, 40) : undefined,
        onProgress: ctx?.onProgress,
      });
      const sizeMb = Number((fs.statSync(file).size / 1e6).toFixed(2));
      mutate(p.id, ctx, 'export_video', () => ({ log: `${fileName} (${res.duration}s, ${sizeMb} МБ)` }));
      return { file, fileName, duration: res.duration, sizeMb };
    },
  },
];

export const opByName = Object.fromEntries(ops.map((o) => [o.name, o]));
export { HOME };
