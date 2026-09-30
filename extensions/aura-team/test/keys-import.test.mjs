/*---------------------------------------------------------------------------------------------
 *  Импорт ключей из плагина API Keys в банк команды: правила маппинга.
 *  Проверяются чистые функции из out/keys/importMapping.js (сборка tsc) — без vscode.
 *--------------------------------------------------------------------------------------------*/
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, '..', 'out', 'keys', 'importMapping.js');
if (!existsSync(compiled)) {
	console.error('FAIL: out/keys/importMapping.js не найден — сначала tsc -p tsconfig.json');
	process.exit(1);
}
const require = createRequire(import.meta.url);
const m = require(compiled);

let failures = 0;
const check = (name, ok, extra = '') => {
	if (ok) { console.log('  ok  ', name); } else { failures++; console.log('  FAIL', name, extra); }
};

/* Приоритет: строка плагина ключей → целое банка команды (меньше — выше). */
check('priority: high → 10', m.mapAuraPriority('high') === 10);
check('priority: medium → 100', m.mapAuraPriority('medium') === 100);
check('priority: low → 500', m.mapAuraPriority('low') === 500);
check('priority: HIGH регистронезависимо', m.mapAuraPriority('HIGH') === 10);
check('priority: число в диапазоне сохраняется', m.mapAuraPriority(42) === 42);
check('priority: мусор → 100', m.mapAuraPriority('как-нибудь') === 100 && m.mapAuraPriority(undefined) === 100);

/* Хост адреса — ключ для поиска уже зарегистрированного шлюза. */
check('originOf отбрасывает путь и порт-хвост', m.originOf('https://gateway.example.com/v1/chat') === 'https://gateway.example.com');
check('originOf сохраняет порт', m.originOf('http://127.0.0.1:8080/v1') === 'http://127.0.0.1:8080');
check('originOf на мусоре — пусто', m.originOf('не url') === '' && m.originOf(undefined) === '');

const providers = [
	{ id: 'openai', name: 'OpenAI', origin: 'https://api.openai.com', builtin: true },
	{ id: 'gateway', name: 'Team gateway', origin: 'https://llm.example.dev', builtin: false }
];

/* Подбор провайдера: по id, затем по origin из baseUrl, затем по имени. */
check('провайдер находится по id', m.matchTeamProvider(providers, { provider: 'openai' })?.id === 'openai');
check('провайдер находится по origin', m.matchTeamProvider(providers, { baseUrl: 'https://llm.example.dev/v1' })?.id === 'gateway');
check('провайдер находится по имени ключа', m.matchTeamProvider(providers, { name: 'Team gateway' })?.id === 'gateway');
check('неизвестный провайдер — undefined (значит нужен шлюз)', m.matchTeamProvider(providers, { provider: 'unknown', baseUrl: 'https://new.example.dev/v1' }) === undefined);

/* Черновик провайдера для своего шлюза: openai-совместимые пути и probe. */
const draft = m.providerDraftFrom({ name: 'My Gateway', baseUrl: 'https://llm.example.dev/v1/chat/completions' });
check('черновик: origin без пути', draft.origin === 'https://llm.example.dev');
check('черновик: имя из ключа', draft.name === 'My Gateway');
check('черновик: bearer-авторизация', draft.authScheme === 'bearer');
check('черновик: разрешённые пути только к моделям и чату', draft.allowedPaths.length === 2 && draft.allowedPaths.some(p => p.path === '/v1/models') && draft.allowedPaths.some(p => p.path === '/v1/chat/completions'));
check('черновик: без baseUrl origin пустой (сервер откажет — и это видно)', m.providerDraftFrom({ name: 'X' }).origin === '');

/* Метка ключа: имя → модель → дефолт. */
check('метка берётся из имени', m.importLabelOf({ id: '1', name: 'Основной' }) === 'Основной');
check('метка падает на модель', m.importLabelOf({ id: '1', model: 'gpt-4o-mini' }) === 'gpt-4o-mini');
check('метка по умолчанию', m.importLabelOf({ id: '1' }) === 'API key');

/* Итог импорта для тоста: сколько прошло и почему нет. */
const summary = m.summarizeImport({ imported: 2, skipped: [{ name: 'a', reason: 'no-secret' }, { name: 'b', reason: 'no-secret' }, { name: 'c', reason: 'error' }] });
check('summary: счётчики и причины', summary === '2/5 no-secret:2 error:1', summary);
check('summary без пропусков', m.summarizeImport({ imported: 3, skipped: [] }) === '3/3');

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
