#!/usr/bin/env node
// MCP server (stdio): exposes the editing operations as tools for an AI agent.
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ops, opByName } from './ops.js';

const INSTRUCTIONS = `Видеостудия: ты монтируешь ролики, вызывая инструменты.
Порядок работы: create_project → import_media (файлы пользователя) или create_background → add_clip на дорожки →
remove_silences для чистки пауз → add_texts для субтитров и заголовков → render_frame, чтобы проверить картинку глазами → export_video.
Дорожки: V1 — основной видеоряд, V2 — перебивки поверх него (по умолчанию без звука), A1/A2 — музыка и звук.
Все времена в секундах. После remove_silences времена сдвигаются — перечитай get_timeline, прежде чем ставить тексты.
Пользователь видит таймлайн вживую в веб-редакторе (npm start).`;

const server = new Server({ name: 'video-studio', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ops.map((o) => ({ name: o.name, description: o.description, inputSchema: o.schema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const op = opByName[req.params.name];
  if (!op) return { isError: true, content: [{ type: 'text', text: `Неизвестный инструмент: ${req.params.name}` }] };
  try {
    const result = await op.run(req.params.arguments || {}, { actor: 'agent' });
    const { log: _log, image, ...data } = result && !Array.isArray(result) ? result : { list: result };
    const content = [{ type: 'text', text: JSON.stringify(Array.isArray(result) ? result : data, null, 1) }];
    if (image) content.push({ type: 'image', data: fs.readFileSync(image).toString('base64'), mimeType: 'image/jpeg' });
    return { content };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
});

await server.connect(new StdioServerTransport());
