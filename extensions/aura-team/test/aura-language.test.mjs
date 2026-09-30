/*---------------------------------------------------------------------------------------------
 *  Язык панели Team следует общему переключателю Aura.
 *
 *  Регрессия, которую держим: у Team была своя настройка auraTeam.uiLanguage со
 *  значением 'ru' по умолчанию, и общий переключатель ide (aura.language) её не
 *  касался. В итоге маркет переключался на английский, а панель Team оставалась
 *  русской — «один переключатель на всю IDE» не работал.
 *
 *  Тест статический: uiLanguage — замыкание внутри activate(), снаружи не вызывается.
 *--------------------------------------------------------------------------------------------*/
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extension = readFileSync(join(here, '..', 'src', 'extension.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

let failures = 0;
const check = (name, ok, detail) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + name);
	if (!ok) { failures++; if (detail) { console.log('       ' + detail); } }
};

/* ---------- 1. Настройка: по умолчанию — общий переключатель ---------- */

const setting = pkg.contributes.configuration.properties['auraTeam.uiLanguage'];
check('настройка auraTeam.uiLanguage есть в манифесте', !!setting);
check('дефолт настройки — auto (общий переключатель Aura)', setting?.default === 'auto', `default=${setting?.default}`);
check('в enum есть auto, ru и en', ['auto', 'ru', 'en'].every(value => setting?.enum?.includes(value)), setting?.enum);
check('подписей в списке столько же, сколько значений',
	setting?.enumDescriptions?.length === setting?.enum?.length,
	`${setting?.enumDescriptions?.length} подписей на ${setting?.enum?.length} значений`);

/* ---------- 2. Разрешение языка: авто идёт за aura.language ---------- */

const start = extension.indexOf('const uiLanguage = ()');
const end = extension.indexOf('\n\t};', start);
const body = start < 0 ? '' : extension.slice(start, end < 0 ? undefined : end);

check('тело uiLanguage найдено', body.length > 0, `start=${start} end=${end}`);
check('своя настройка читается с фолбэком auto', /getConfiguration\('auraTeam'\)\.get<string>\('uiLanguage', 'auto'\)/.test(body));
check('общий переключатель читается из настройки ядра aura.language', /getConfiguration\('aura'\)\.get<string>\('language', 'auto'\)/.test(body));
check('явные ru/en имеют приоритет над авто',
	/if \(setting === 'ru' \|\| setting === 'en'\) \{ return setting; \}/.test(body), body.slice(0, 200));
check('язык IDE — только последний фолбэк',
	/aura === 'ru' \|\| aura === 'en' \? aura : vscode\.env\.language/.test(body));

/* ---------- 3. Язык доходит до webview и обновляется на лету ---------- */

check('состояние панели несёт uiLanguage', /uiLanguage: uiLanguage\(\),/.test(extension));
check('смена aura.language перерисовывает панель без перезагрузки окна',
	/e\.affectsConfiguration\('aura\.language'\)[\s\S]{0,200}void broadcast\(\);/.test(extension),
	'без слушателя открытая панель останется на старом языке до перезагрузки окна');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
