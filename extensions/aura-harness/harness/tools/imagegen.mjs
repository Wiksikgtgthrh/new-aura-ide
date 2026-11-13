#!/usr/bin/env node
/**
 * imagegen.mjs — генерирует изображения встроенной моделью шлюза ZCode.
 *
 *   node ~/.agent-harness/tools/imagegen.mjs <out.png> "<prompt>" [size] [--ref <img>]
 *
 * Почему так, а не /v1/images/generations: шлюз отклоняет этот эндпоинт
 * (400 invalid_request_error), а картинки отдаёт инструмент image_generation
 * в /v1/responses. Модель — gpt/gpt-image-2.5.
 *
 * Ключ берётся из ~/.zcode/v2/provider_config.json в момент вызова: в коде,
 * логах и репозитории его нет. Размеры: 1024x1024, 1536x1024, 1024x1536, auto.
 * Без --ref модель рисует с нуля; с --ref правит присланную картинку.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
const IMAGE_MODEL = 'gpt/gpt-image-2.5';
const TEXT_MODEL = 'gpt/gpt-6.1-sol';
const VALID_SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);

const argv = process.argv.slice(2);
let ref = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--ref') ref = argv[++i];
  else positional.push(argv[i]);
}

const [out, prompt, sizeArg] = positional;
const size = sizeArg ?? '1024x1024';

if (!out || !prompt) {
  console.error('usage: imagegen.mjs <out.png> "<prompt>" [size] [--ref <img>]');
  process.exit(1);
}
if (!VALID_SIZES.has(size)) {
  console.error(`недопустимый размер: ${size} (можно: ${[...VALID_SIZES].join(', ')})`);
  process.exit(1);
}

function providers() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return [];
  }
  const rules = cfg?.config?.providerConfigRules?.providerRules ?? [];
  return rules
    .map((r) => ({
      base: r?.config?.api?.baseUrl?.replace(/\/$/, ''),
      type: r?.config?.api?.type,
      key: r?.config?.access?.apiKey,
      enabled: r?.enabled !== false,
    }))
    .filter((p) => p.enabled && p.type === 'openai-chat-completions' && p.base && p.key);
}

async function listModels(base, key) {
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`models ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map((m) => m.id);
}

async function pickGateway() {
  for (const p of providers()) {
    try {
      const ids = await listModels(p.base, p.key);
      if (ids.includes(IMAGE_MODEL)) return p;
    } catch {
      /* провайдер недоступен — пробуем следующий */
    }
  }
  return null;
}

async function generate(gw, promptText, size, refPath, attempt = 1) {
  const content = [{ type: 'input_text', text: `Generate an image: ${promptText}` }];
  if (refPath) {
    const b64 = fs.readFileSync(refPath).toString('base64');
    const ext = path.extname(refPath).slice(1).toLowerCase() || 'png';
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    content.push({ type: 'input_image', image_url: `data:image/${mime};base64,${b64}` });
  }

  const res = await fetch(`${gw.base}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gw.key}` },
    body: JSON.stringify({
      model: TEXT_MODEL,
      input: [{ role: 'user', content }],
      tools: [{ type: 'image_generation', size }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // 503/429 — шлюз перегружен, повторяем с растущей паузой; 4xx — нет смысла
    if ((res.status === 503 || res.status === 429) && attempt < 6) {
      const wait = Math.min(60, 8 * attempt);
      console.error(`  ${res.status}, ждём ${wait} с и пробуем снова (попытка ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return generate(gw, promptText, size, refPath, attempt + 1);
    }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const call = (data.output ?? []).find((o) => o.type === 'image_generation_call' && o.result);
  if (!call) {
    throw new Error(`в ответе нет картинки: ${(data.output ?? []).map((o) => o.type).join(', ')}`);
  }
  return Buffer.from(call.result, 'base64');
}

const gw = await pickGateway();
if (!gw) {
  console.error(
    'Шлюз со встроенной генерацией не найден. Проверьте, что в настройках ZCode ' +
      'подключён провайдер (Settings → Models), и повторите.',
  );
  process.exit(2);
}

const started = Date.now();
try {
  const png = await generate(gw, prompt, size, ref);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, png);
  const kb = Math.round(png.length / 1024);
  const sec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`OK ${out} — ${kb} KB, ${sec} с, ${size}${ref ? ', с референсом' : ''}`);
} catch (err) {
  console.error(`Не вышло: ${err.message}`);
  process.exit(3);
}
