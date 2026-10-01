// Язык панели: настройка важнее языка IDE, незнакомое считается английским.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { transformSync } = require('esbuild');

function loadTs(relativePath) {
	const file = path.join(root, relativePath);
	const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code;
	const module = { exports: {} };
	new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
		module.exports, require, module, file, path.dirname(file)
	);
	return module.exports;
}

const { resolveUiLanguage, languageName } = loadTs('src/util/language.ts');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

/**
 * Словари панели лежат прямо в скрипте template.html — достаём объект DICTS.
 * Так тест видит ровно то, что уедет в webview, а не копию строк.
 */
function panelDicts() {
	const template = read(path.join('src', 'panel', 'template.html'));
	const open = template.indexOf('{', template.indexOf('const DICTS = {'));
	let depth = 0;
	let end = open;
	for (; end < template.length; end++) {
		if (template[end] === '{') { depth++; }
		else if (template[end] === '}') { depth--; if (depth === 0) { end++; break; } }
	}
	return new Function(`return (${template.slice(open, end)});`)();
}

/** Пути всех листьев словаря: ['title', 'statuses.done', ...]. */
function leafPaths(value, prefix = '') {
	return Object.keys(value).flatMap(key => (value[key] && typeof value[key] === 'object')
		? leafPaths(value[key], `${prefix}${key}.`)
		: [`${prefix}${key}`]);
}

test('resolveUiLanguage: настройка важнее языка IDE', () => {
	assert.equal(resolveUiLanguage('ru', 'en-US'), 'ru');
	assert.equal(resolveUiLanguage('en', 'ru'), 'en');
});

test('resolveUiLanguage: auto следует языку IDE', () => {
	assert.equal(resolveUiLanguage('auto', 'ru'), 'ru');
	assert.equal(resolveUiLanguage('auto', 'ru-RU'), 'ru');
	assert.equal(resolveUiLanguage('auto', 'en-US'), 'en');
	assert.equal(resolveUiLanguage(undefined, undefined), 'en', 'без языка — английский, а не пустая строка');
});

test('resolveUiLanguage: auto сначала слушает общий переключатель aura.language', () => {
	assert.equal(resolveUiLanguage('auto', 'en-US', 'ru'), 'ru', 'общий переключатель Aura важнее языка IDE');
	assert.equal(resolveUiLanguage('auto', 'ru-RU', 'en'), 'en');
	assert.equal(resolveUiLanguage('auto', 'ru-RU', 'auto'), 'ru', "aura.language=auto отдаёт решение языку IDE");
	assert.equal(resolveUiLanguage('auto', 'ru-RU', undefined), 'ru', 'без настройки Aura поведение прежнее');
	assert.equal(resolveUiLanguage('auto', 'ru-RU', 'de'), 'ru', 'мусор в aura.language не должен ломать язык IDE');
	// Своя настройка точечная и важнее общего переключателя.
	assert.equal(resolveUiLanguage('ru', 'en-US', 'en'), 'ru');
	assert.equal(resolveUiLanguage('en', 'ru-RU', 'ru'), 'en');
});

test('languageName: язык подсказки модели в именительном падеже', () => {
	assert.equal(languageName('ru'), 'Russian');
	assert.equal(languageName('en'), 'English');
	assert.equal(languageName('de'), 'English');
});

// Панель по умолчанию идёт за общим переключателем: своя настройка остаётся
// точечным переопределением, а не вторым независимым ответом на вопрос «какой язык».
test('панель по умолчанию следует общему переключателю языка', () => {
	const pkg = JSON.parse(read('package.json'));
	const setting = pkg.contributes.configuration.properties['langgraphOrchestrator.uiLanguage'];
	assert.equal(setting.default, 'auto', 'дефолт — auto: панель обязана слушать общий aura.language');
	assert.deepEqual(setting.enum, ['auto', 'ru', 'en']);
	assert.match(read(path.join('src', 'util', 'config.ts')), /uiLanguage: cfg\.get<UiLanguage>\('uiLanguage', 'auto'\)/,
		'фолбэк в коде не должен расходиться с манифестом');
});

// Манифест больше не ходит через package.nls: VS Code выбирает nls-файл по локали IDE,
// а палитра и настройки оркестратора должны быть русскими в любой локали.
test('манифест не зависит от локали IDE', () => {
	const raw = read('package.json');
	assert.ok(!/%[A-Za-z0-9_.]+%/.test(raw), 'не должно остаться %ключей%: их значение подставляет IDE по своей локали');

	const pkg = JSON.parse(raw);
	const cyrillic = /[А-Яа-яЁё]/;
	assert.match(pkg.displayName, cyrillic, 'имя расширения в списке расширений');
	assert.match(pkg.description, cyrillic, 'описание расширения');
	assert.match(pkg.contributes.configuration.title, cyrillic, 'заголовок раздела настроек');
	assert.match(pkg.contributes.viewsContainers.activitybar[0].title, cyrillic, 'подпись контейнера в активити-баре');
	assert.match(pkg.contributes.views.auraOrchestrator[0].name, cyrillic, 'имя вью' );
	assert.match(pkg.contributes.customEditors[0].displayName, cyrillic, 'имя кастомного редактора');

	for (const command of pkg.contributes.commands) {
		assert.match(command.title, cyrillic, `команда ${command.command}: заголовок в палитре`);
		assert.match(command.category, cyrillic, `команда ${command.command}: категория в палитре`);
	}
	for (const [name, property] of Object.entries(pkg.contributes.configuration.properties)) {
		assert.match(property.description, cyrillic, `настройка ${name}: описание`);
		// Без enumDescriptions выпадающий список в Settings показывал бы машинные значения.
		for (const text of property.enumDescriptions ?? []) {
			assert.match(text, cyrillic, `настройка ${name}: подпись значения списка`);
		}
		if (property.enumDescriptions) {
			assert.equal(property.enumDescriptions.length, property.enum.length, `настройка ${name}: подписей столько же, сколько значений`);
		}
	}
});

// Сырое 'auto' webview разрешает по navigator.language, а сайдкар — по языку IDE:
// два независимых решения. Поэтому хост отдаёт панели уже разрешённый язык.
test('хост отдаёт панели разрешённый язык с учётом общего переключателя', () => {
	const host = read(path.join('src', 'host.ts'));
	assert.match(host, /uiLanguage: resolveUiLanguage\(this\.config\.uiLanguage, vscode\.env\.language, auraLanguageSetting\(\)\)/);
	// Настройка ядра IDE читается напрямую: своего дубля у расширения быть не должно.
	assert.match(host, /function auraLanguageSetting\(\): UiLanguage \{[\s\S]*?getConfiguration\('aura'\)\.get<string>\('language', 'auto'\)/);
	assert.ok(!/uiLanguage: this\.config\.uiLanguage/.test(host), "в снапшот не должен уходить сырой 'auto'");
	// Переключатель меняется без перезагрузки окна: открытая панель обязана перерисоваться.
	assert.match(host, /if \(e\.affectsConfiguration\('aura\.language'\)\) \{\s*this\.pushState\(\);/,
		'смена aura.language не доходит до панели — язык останется старым до перезагрузки');
});

// Имя виртуального документа = подпись вкладки редактора.
test('вкладка панели подписана «Оркестратор»', () => {
	assert.match(read(path.join('src', 'panel', 'panelProvider.ts')), /path: '\/Оркестратор'/);
});

// Значение, совпадающее в ru и en, — почти всегда забытый перевод (так проскочила «Used today»).
// Белый список — только технические токены: тиры, «auto», подпись diff. Имена вкладок из него
// убраны: они и оставались последним английским текстом в русской панели.
test('в русском словаре панели нет забытых английских строк', () => {
	const dicts = panelDicts();
	const value = (dict, path) => path.split('.').reduce((node, key) => node[key], dict);
	const ru = leafPaths(dicts.ru);
	const allowed = new Set([
		// Сокращения единиц совпадают по смыслу, но не по написанию — белый список пуст.
	]);

	const forgotten = ru.filter(path => !allowed.has(path) && value(dicts.ru, path) === value(dicts.en, path));
	assert.deepEqual(forgotten, [], 'эти строки в ru-словаре совпадают с английскими — перевод забыт');
	// Запись в белом списке, которая уже не нужна, — тоже ошибка: ключ переименовали, а запись осталась.
	const stale = [...allowed].filter(path => !ru.includes(path) || value(dicts.ru, path) !== value(dicts.en, path));
	assert.deepEqual(stale, [], 'эту запись белого списка пора убрать');
});

test('словари панели ru и en описывают одни и те же строки', () => {
	const dicts = panelDicts();
	const ru = leafPaths(dicts.ru).sort();
	const en = leafPaths(dicts.en).sort();
	assert.deepEqual(en, ru, 'наборы ключей ru/en обязаны совпадать: иначе часть интерфейса останется непереведённой');
	assert.ok(ru.length > 100, 'словарь подозрительно мал — похоже, тест читает не тот объект');
	const flat = value => Object.values(value).flatMap(item => (item && typeof item === 'object') ? flat(item) : [item]);
	assert.ok(flat(dicts.ru).every(text => typeof text === 'string' && text.trim()), 'в словаре нет пустых строк');
	assert.match(JSON.stringify(dicts.ru), /[А-Яа-яЁё]/, 'русский словарь обязан быть русским, а не копией английского');
});
