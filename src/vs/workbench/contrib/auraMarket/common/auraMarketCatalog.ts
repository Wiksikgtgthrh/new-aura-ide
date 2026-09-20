/*---------------------------------------------------------------------------------------------
 *  Aura Market — каталог плагинов и наборов скилов + состояние установки/отключения.
 *--------------------------------------------------------------------------------------------*/

export type AuraMarketItemKind = 'plugin' | 'skillset';

export interface IAuraMarketVersion {
	/** Версия (semver). */
	readonly version: string;
	/** Дата публикации (ISO или человекочитаемая). */
	readonly date: string;
	/** Список изменений для этой версии. */
	readonly changelog: readonly string[];
}

export interface IAuraMarketItem {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly kind: AuraMarketItemKind;
	/** Последняя (актуальная) версия — сокращение versions[0]. */
	readonly version?: string;
	/** История версий: новая сверху. */
	readonly versions?: readonly IAuraMarketVersion[];
	readonly author?: string;
	/** Подробная документация (кнопка «Документация»). */
	readonly docs?: string;
	/** Id встроенного плагина сборки — установка активирует его после перезагрузки окна. */
	readonly builtinId?: string;
	/** Человекочитаемый размер (что потребуется докачать при установке). */
	readonly size?: string;
}

export function auraMarketInstalledKey(itemId: string): string {
	return `auraMarket.installed.${itemId}`;
}

/** Флаг отключения: плагин установлен, но временно выключен (иконка и функции скрыты до включения). */
export function auraMarketDisabledKey(itemId: string): string {
	return `auraMarket.disabled.${itemId}`;
}

/** Установлен ли плагин и не отключён ли он. */
export function isAuraItemActive(get: (key: string, scope: StorageScopeLike, fallback: string) => string, itemId: string): boolean {
	return get(auraMarketInstalledKey(itemId), StorageScopeLike.APPLICATION, 'false') === 'true'
		&& get(auraMarketDisabledKey(itemId), StorageScopeLike.APPLICATION, 'false') !== 'true';
}

/** Минимальная заглушка scope, чтобы не тянуть IStorageService в common-код. */
export enum StorageScopeLike { APPLICATION = 0, WORKSPACE = 1 }

/**
 * Каталог Aura Market. Добавляйте сюда свои плагины и наборы скилов.
 */
export const AURA_MARKET_ITEMS: IAuraMarketItem[] = [
	{
		id: 'aura-kotlin',
		builtinId: 'aura-kotlin',
		name: 'Kotlin & Android',
		kind: 'plugin',
		version: '0.2.0',
		versions: [
			{
				version: '0.2.0',
				date: '2026-09-19',
				changelog: [
					'Полноценные шаги отладчика: next / stepIn / stepOut / pause через JDWP StepRequest',
					'Точная строка останова при шаге — редактор прыгает по коду',
					'Исправлен clearAllBreakpoints (лишний async)',
				]
			},
			{
				version: '0.1.0',
				date: '2026-09-05',
				changelog: [
					'Первая версия: classpath из Gradle, задачи Gradle, logcat, запуск и отладка по F5',
				]
			}
		],
		author: 'IDE',
		description: 'Kotlin и Android без Android Studio: classpath из Gradle через init-скрипт (транзитивные зависимости, android.jar), задачи Gradle с problem matcher, Android SDK и эмуляторы, запуск и отладка по F5 (JDWP), logcat с фильтрами, автодополнение и диагностика через LSP.',
		size: '≈ 150 КБ сам плагин; Kotlin Language Server докачивается при первом открытии .kt (~83 МБ, или включите offline-комплект в сборку); toolchain (JDK 11+ + Android SDK) — до 6 ГБ, если ещё не установлен',
		docs: [
			'Aura Kotlin & Android — полноценная разработка Kotlin/Android в Aura IDE.',
			'',
			'БЫСТРЫЙ СТАРТ',
			'1. Откройте существующий Android-проект (Gradle) — classpath соберётся автоматически через init-скрипт Gradle; парсер build-файлов работает как фолбэк.',
			'2. Сборка: команды Gradle — Sync, Build (assembleDebug), Clean, Tests, Release или произвольная задача; ошибки — в панели Problems, прогресс — в статус-баре.',
			'3. Устройства и эмуляторы: панель Android в activity bar — запуск/остановка AVD, единый селектор устройств, logcat с фильтром по приложению.',
			'4. Запуск и отладка: F5 («Run Android App») — собирает APK, ставит на устройство, запускает и цепляет отладчик (точки останова, переменные, стек).',
			'5. Автодополнение: Kotlin Language Server ставится по кнопке при первом открытии .kt (или попадите в комплект через scripts/fetch-server). Нужен JDK 11+ (подойдёт JDK из Android Studio) — укажите его в auraKotlin.javaPath.',
		].join('\n'),
	},
	{
		id: 'aura-api',
		builtinId: 'aura-api',
		name: 'API Keys',
		kind: 'plugin',
		version: '1.0.0',
		versions: [
			{
				version: '1.0.0',
				date: '2026-09-14',
				changelog: [
					'Менеджер ключей: хранение в Secret Storage, группы, приоритеты',
					'Автопроверка пинга, проверка подлинности модели и безопасности ответов',
					'Выбор активного ключа для чата («В чат»)',
				]
			}
		],
		author: 'IDE',
		description: 'Менеджер API-ключей: хранение, группировка, приоритеты, автопроверка пинга и ошибок, проверка подлинности модели и безопасности ответов, выбор активного ключа для чата.',
		size: '≈ 90 КБ',
		docs: [
			'Aura API — встроенный менеджер API-ключей.',
			'',
			'УСТАНОВКА',
			'Нажмите «Установить» и перезагрузите окно. После перезагрузки в левой панели появится иконка ключа (Aura API), а менеджер открывается центральной вкладкой.',
			'',
			'ДОБАВЛЕНИЕ КЛЮЧЕЙ',
			'• Вручную: кнопка «+ Добавить ключ» — название, Base URL, модель, ожидаемая модель (для проверки подлинности), группа, сам ключ.',
			'• Массово: кнопка «Массовый импорт». Форматы:',
			'  — построчно: название | baseUrl | модель | ключ',
			'  — JSON-массив: [{ "name", "baseUrl", "model", "key", "group"?, "priority"? }]',
			'Ключи хранятся в зашифрованном системном хранилище (Secret Storage), в файлы не пишутся.',
			'',
			'ГРУППЫ И ПРИОРИТЕТЫ',
			'Любому ключу можно задать группу (фильтр над таблицей) и приоритет: Высокий / Средний / Низкий. При выборе «лучшего» ключа сначала приоритет, затем минимальный пинг.',
			'',
			'АВТОПРОВЕРКА',
			'Каждый ключ проверяется автоматически при добавлении, а также кнопками «Проверить» / «Проверить все»:',
			'• Пинг — время ответа на GET /models. Ключи с пингом выше 3000 мс помечаются «исключён из использования» и не выбираются для чата.',
			'• Ошибки — конкретная причина: HTTP 401 (ключ отклонён), HTTP 404 (baseUrl не OpenAI-совместимый), сетевые ошибки и т.д.',
			'',
			'ПОДЛИННОСТЬ МОДЕЛИ, %',
			'Модели задаётся пробный вопрос «назови свою точную модель», ответ сравнивается с заявленной: 100% — точное совпадение, 80% — совпало семейство, 50% — частичное, 20% — ответ не похож.',
			'',
			'ПРОВЕРКА БЕЗОПАСНОСТИ, %',
			'Ответы модели сканируются на вредоносные паттерны: rm -rf / del /s, PowerShell -enc, curl | bash, Invoke-Expression, автозагрузка в реестре. Каждое замечание снижает оценку; baseUrl без HTTPS — штраф 20%. Детали — в подсказке при наведении на процент.',
			'',
			'ИСПОЛЬЗОВАНИЕ В ЧАТЕ',
			'Кнопка «В чат» у строки проверяет ключ и делает его активным эндпоинтом (auraApi.chat.baseUrl / auraApi.chat.model) для чата с ИИ.',
		].join('\n'),
	},
	{
		id: 'aggg',
		builtinId: 'aggg',
		name: 'AGGG Boost',
		kind: 'plugin',
		version: '2.0.0',
		versions: [
			{
				version: '2.0.0',
				date: '2026-09-10',
				changelog: [
					'Ядро правил AGGG2.0 в системном промпте чата на каждый ход',
					'Включение глобально (aggg.enabled) или на проект (aggg.projectBoost)',
				]
			}
		],
		author: 'AGGG',
		description: 'Обвязка-бустер моделей: встраивает ядро правил AGGG2.0 в системный промпт чата на каждый ход. Включается глобально (aggg.enabled) или отдельно на проект (aggg.projectBoost в настройках workspace). Индикатор и переключатель — в статус-баре.',
		size: '≈ 25 КБ',
		docs: [
			'AGGG Boost — обвязка, усиливающая модели чата ядром правил AGGG2.0.',
			'',
			'УСТАНОВКА',
			'Нажмите «Установить» и перезагрузите окно. В статус-баре справа появится индикатор «AGGG».',
			'',
			'ВКЛЮЧЕНИЕ',
			'• Глобально (все проекты): настройка aggg.enabled = true, или клик по индикатору в статус-баре → «Глобально».',
			'• Только на проект: клик по индикатору → «Только этот проект» (записывает aggg.projectBoost в настройки workspace).',
			'Команда: «AGGG: Переключить буст моделей» (Ctrl+Shift+P).',
			'',
			'КАК РАБОТАЕТ',
			'Когда буст активен, к каждому запросу моделей чата (Aura API) первым системным сообщением добавляется ядро правил AGGG2.0: ресёрч первым, база до кода, скиллы на задачу, проверка «готово» и т.д. Пользовательский системный промпт (auraApi.chat.systemPrompt) идёт следом и не затирается.',
		].join('\n'),
	},
	{
		id: 'aura-serverkit',
		builtinId: 'aura-serverkit',
		name: 'ServerKit',
		kind: 'plugin',
		version: '0.1.0',
		versions: [
			{
				version: '0.1.0',
				date: '2026-09-08',
				changelog: [
					'Первая версия: панель ServerKit во вкладке IDE, статус и открытие приложения',
				]
			}
		],
		author: 'IDE',
		description: 'Панель управления сервером ServerKit во вкладке IDE: деплой приложений, базы данных, Docker-контейнеры, SSL и мониторинг. Иконка сбоку — клик открывает вкладку с приложением.',
		size: '≈ 10 КБ',
		docs: [
			'ServerKit — панель управления сервером прямо из IDE.',
			'',
			'УСТАНОВКА',
			'Нажмите «Установить» и перезагрузите окно. Слева в activity bar появится иконка сервера (ServerKit).',
			'',
			'ИСПОЛЬЗОВАНИЕ',
			'• Клик по иконке в activity bar открывает сайдбар с карточкой ServerKit.',
			'• Кнопка «Открыть панель управления» открывает полноценную вкладку редактора с приложением ServerKit.',
			'• Вкладка показывает состояние сервера (зелёный/красный индикатор, автообновление каждые 30 секунд) и приложение целиком.',
			'• Команды (Ctrl+Shift+P): «ServerKit: Открыть панель управления», «ServerKit: Проверить статус сервера».',
			'',
			'НАСТРОЙКА',
			'• auraServerkit.serverUrl — URL развернутого ServerKit (по умолчанию https://serverkit.auraide.xyz).',
			'Плагин не содержит самого приложения: ServerKit крутится на вашем сервере, вкладка лишь отображает его и проверяет доступность через /api/health.',
		].join('\n'),
	},
];

export type AuraMarketFilter = 'all' | AuraMarketItemKind;
