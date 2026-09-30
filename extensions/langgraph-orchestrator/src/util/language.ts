/*---------------------------------------------------------------------------------------------
 *  Язык панели и языка, на котором команда агентов пишет заметки и итог.
 *
 *  Настройка langgraphOrchestrator.uiLanguage: 'auto' — как в IDE, иначе ru/en.
 *  Модуль чистый (без vscode), поэтому проверяется node-тестами (test/language.test.mjs).
 *--------------------------------------------------------------------------------------------*/

export type UiLanguage = 'auto' | 'ru' | 'en';

/**
 * Итоговый язык: 'ru'/'en' из своей настройки — приоритетнее всего, 'auto'
 * разрешается сначала общим переключателем aura.language, потом языком
 * редактора (vscode.env.language). Всё незнакомое считается английским.
 *
 * Третий аргумент — настройка aura.language: одна на весь IDE, поэтому 'auto'
 * здесь честно означает «как решил общий переключатель», а не «как захотелось
 * этой панели».
 */
export function resolveUiLanguage(setting: UiLanguage | undefined, editorLanguage: string | undefined, auraLanguage?: UiLanguage | undefined): 'ru' | 'en' {
	if (setting === 'ru' || setting === 'en') {
		return setting;
	}
	if (auraLanguage === 'ru' || auraLanguage === 'en') {
		return auraLanguage;
	}
	return String(editorLanguage ?? '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Как назвать язык в подсказке модели: «Russian» / «English». */
export function languageName(language: string | undefined): string {
	return resolveUiLanguage('auto', language) === 'ru' ? 'Russian' : 'English';
}
