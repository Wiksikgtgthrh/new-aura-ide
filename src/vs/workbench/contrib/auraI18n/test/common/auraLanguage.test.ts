/*---------------------------------------------------------------------------------------------
 *  Aura — тесты языка интерфейса.
 *
 *  Ловят три реальные поломки: 'auto' перестал следовать языку IDE (панели и
 *  маркет разъезжаются), мусор в settings.json больше не сводится к 'auto'
 *  (интерфейс падал в английский на пустом языке), у варианта переключателя
 *  пропала подпись (пользователь видит пустой пункт быстрого выбора).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AURA_LANGUAGES, AURA_LANGUAGE_DEFAULT, AURA_LANGUAGE_DESCRIPTIONS, AURA_LANGUAGE_LABELS, AURA_LANGUAGE_SETTING, normalizeAuraLanguage, resolveAuraLanguage } from '../../common/auraLanguage.js';

suite('Aura — язык интерфейса', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('id настройки и её умолчание — «как в IDE»', () => {
		assert.strictEqual(AURA_LANGUAGE_SETTING, 'aura.language');
		assert.strictEqual(AURA_LANGUAGE_DEFAULT, 'auto');
		assert.ok(AURA_LANGUAGES.includes(AURA_LANGUAGE_DEFAULT), 'умолчание должно быть среди вариантов переключателя');
	});

	test('мусор и отсутствие значения сводятся к auto, а не к пустому языку', () => {
		assert.strictEqual(normalizeAuraLanguage(undefined), 'auto');
		assert.strictEqual(normalizeAuraLanguage(null), 'auto');
		assert.strictEqual(normalizeAuraLanguage(''), 'auto');
		assert.strictEqual(normalizeAuraLanguage('RU_RU'), 'auto');
		assert.strictEqual(normalizeAuraLanguage(false), 'auto');
		assert.strictEqual(normalizeAuraLanguage('ru'), 'ru');
		assert.strictEqual(normalizeAuraLanguage('en'), 'en');
	});

	test('auto следует языку IDE, включая региональные варианты', () => {
		assert.strictEqual(resolveAuraLanguage('auto', 'ru'), 'ru');
		assert.strictEqual(resolveAuraLanguage('auto', 'ru-RU'), 'ru');
		assert.strictEqual(resolveAuraLanguage('auto', 'RU'), 'ru');
		assert.strictEqual(resolveAuraLanguage('auto', 'en-US'), 'en');
		assert.strictEqual(resolveAuraLanguage('auto', 'en'), 'en');
	});

	test('без языка IDE — английский, а не пустая строка', () => {
		assert.strictEqual(resolveAuraLanguage('auto', undefined), 'en');
		assert.strictEqual(resolveAuraLanguage(undefined, undefined), 'en');
	});

	test('явный выбор перебивает язык IDE в обе стороны', () => {
		assert.strictEqual(resolveAuraLanguage('ru', 'en-US'), 'ru');
		assert.strictEqual(resolveAuraLanguage('en', 'ru-RU'), 'en');
	});

	test('у каждого варианта есть подпись и пояснение на двух языках', () => {
		for (const language of AURA_LANGUAGES) {
			for (const on of ['ru', 'en'] as const) {
				const label = AURA_LANGUAGE_LABELS[language][on];
				const description = AURA_LANGUAGE_DESCRIPTIONS[language][on];
				assert.ok(label.trim().length > 0, `нет подписи варианта «${language}» на ${on}`);
				assert.ok(description.trim().length > 0, `нет пояснения варианта «${language}» на ${on}`);
			}
		}
	});

	test('настройка зарегистрирована, а переключатель есть и в палитре, и в статус-баре', () => {
		const contribution = fs.readFileSync('src/vs/workbench/contrib/auraI18n/browser/auraLanguage.contribution.ts', 'utf8');
		assert.match(contribution, /\[AURA_LANGUAGE_SETTING\]: \{/, 'настройка aura.language не зарегистрирована — её не будет в Settings');
		assert.match(contribution, /scope: ConfigurationScope\.APPLICATION/, 'язык — свойство пользователя, а не проекта');
		assert.match(contribution, /id: AURA_LANGUAGE_PICK_COMMAND_ID,[\s\S]*?f1: true/, 'нет команды выбора языка в палитре');
		assert.match(contribution, /statusbarService\.addEntry\(entry, AURA_LANGUAGE_STATUSBAR_ID/, 'нет индикатора-переключателя в статус-баре');
		// Язык строк VS Code переключают языковые пакеты: переключатель обязан отдать туда, а не молчать.
		assert.match(contribution, /IDE_LOCALE_COMMAND_ID = 'workbench\.action\.configureLocale'/, 'нет перехода к языковому пакету IDE');
		assert.match(fs.readFileSync('src/vs/workbench/workbench.common.main.ts', 'utf8'), /import '\.\/contrib\/auraI18n\/browser\/auraLanguage\.contribution\.js';/, 'контрибуция не подключена к workbench — настройка и переключатель не загрузятся');
	});

	test('названия языков не переводятся, а «как в IDE» — переводится', () => {
		// «Русский» и «English» — названия на них самих: их нельзя подменять переводом.
		for (const on of ['ru', 'en'] as const) {
			assert.strictEqual(AURA_LANGUAGE_LABELS.ru[on], 'Русский');
			assert.strictEqual(AURA_LANGUAGE_LABELS.en[on], 'English');
		}
		assert.notStrictEqual(AURA_LANGUAGE_LABELS.auto.ru, AURA_LANGUAGE_LABELS.auto.en, 'вариант auto должен переводиться');
	});
});
