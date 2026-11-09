/**
 * Проверка локализации: каждый ключ tr('…') в исходниках должен быть в ru-бандле.
 * Раньше 20 строк тулчейна (установка JDK/Kotlin/Gradle/SDK) уходили в интерфейс
 * по-английски, потому что ключи просто не добавили в bundle.l10n.ru.json.
 * Запуск: node test/l10n.test.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const bundle = JSON.parse(fs.readFileSync(path.join(root, 'l10n', 'bundle.l10n.ru.json'), 'utf8'));

const pattern = /tr\(\s*'((?:[^'\\]|\\.)*)'/g;
const missing = [];
const used = new Set();
for (const file of fs.readdirSync(path.join(root, 'src'))) {
	if (!file.endsWith('.ts')) { continue; }
	const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
	let match;
	while ((match = pattern.exec(source))) {
		const key = match[1].replace(/\\'/g, "'");
		used.add(key);
		if (!(key in bundle)) { missing.push(`${file} :: ${key}`); }
	}
}

// Ключи с {0}/{1} должны иметь ту же нумерацию подстановок, иначе подстановка молча теряется.
const arity = value => new Set([...value.matchAll(/\{(\d+)\}/g)].map(m => m[1])).size;
const arityMismatch = [...used].filter(key => key in bundle && arity(key) !== arity(bundle[key]));

for (const entry of missing) { console.log('MISSING', entry); }
for (const key of arityMismatch) { console.log('ARITY', key, '=>', bundle[key]); }
console.log(`проверено ключей: ${used.size}, без перевода: ${missing.length}, с другой нумерацией: ${arityMismatch.length}`);
process.exit(missing.length || arityMismatch.length ? 1 : 0);
