/*---------------------------------------------------------------------------------------------
 *  Aura Market — тесты каталога плагинов и согласованности с расширениями.
 *
 *  Встроенные расширения Team и LangGraph Orchestrator живут в маркете, а их вью,
 *  команды и инструменты чата гейтятся флагом `auraPlugin.<id>.enabled`, который
 *  выставляет IAuraPluginService.
 *  Тесты ловят три реальные поломки: пункт каталога без builtinId (кнопка
 *  «Установить» ничего не делает), вью с id, которого нет в каталоге (флаг никогда
 *  не привязывается и плагин пропадает из боковой панели) и команду с инструментом
 *  чата без гейта — после отключения плагина они остаются в палитре и у модели.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AURA_MARKET_ITEMS, auraPluginEnabledWhenClause } from '../../common/auraMarketCatalog.js';
import { AURA_MARKET_ITEMS_EN } from '../../common/auraMarketCatalog.en.js';
import { IAuraMarketText, auraMarketItems, auraMarketText } from '../../common/auraMarketI18n.js';
import { AGENT_TEAM_ENABLED_WHEN, AGENT_TEAM_TOOL_ID, AGENT_TEAM_TOOL_REFERENCE_NAME } from '../../../auraApi/common/auraApiChatTools.js';

/** Файл расширения как JSON: читаем с диска, а не из out — это проверка связки репозитория. */
function readExtensionPackage(extension: string): any {
	const path = `extensions/${extension}/package.json`;
	return JSON.parse(fs.readFileSync(path, 'utf8'));
}

/** when-клауза вью расширения по id вью. */
function viewWhen(extension: string, container: string, view: string): string | undefined {
	const pkg = readExtensionPackage(extension);
	const views: Array<{ id: string; when?: string }> = pkg?.contributes?.views?.[container] ?? [];
	return views.find(item => item.id === view)?.when;
}

/** Кириллица в английском тексте — признак непереведённой строки. */
const CYRILLIC = /[А-Яа-яЁё]/;

/** Команды расширения из contributes.commands. */
function contributedCommands(extension: string): Array<{ command: string; enablement?: string }> {
	return readExtensionPackage(extension)?.contributes?.commands ?? [];
}

/** Инструменты чата расширения из contributes.languageModelTools. */
function contributedTools(extension: string): Array<{ name: string; toolReferenceName?: string; when?: string }> {
	return readExtensionPackage(extension)?.contributes?.languageModelTools ?? [];
}

suite('Aura Market — каталог плагинов', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('id пунктов уникальны', () => {
		const ids = AURA_MARKET_ITEMS.map(item => item.id);
		assert.strictEqual(new Set(ids).size, ids.length, 'в каталоге есть дубли id');
	});

	test('у каждого пункта есть builtinId, описание, версии и документация', () => {
		for (const item of AURA_MARKET_ITEMS) {
			assert.ok(item.builtinId, `«${item.id}»: без builtinId установка через маркет не сработает`);
			assert.ok(item.name.trim().length > 0, `«${item.id}»: пустое имя`);
			assert.ok(item.description.trim().length > 0, `«${item.id}»: пустое описание`);
			assert.ok((item.docs ?? '').trim().length > 0, `«${item.id}»: нет документации для читалки`);
			assert.ok(item.versions?.length, `«${item.id}»: нет истории версий`);
			assert.strictEqual(item.versions?.[0].version, item.version, `«${item.id}»: version не совпадает с первой версией`);
		}
	});

	test('имя плагина не содержит слова «Aura» — бренд не дублируется', () => {
		for (const item of AURA_MARKET_ITEMS) {
			assert.ok(!item.name.includes('Aura'), `«${item.id}»: в имени осталось «Aura»`);
		}
	});

	test('Team и LangGraph Orchestrator есть в каталоге как плагины', () => {
		const byId = new Map(AURA_MARKET_ITEMS.map(item => [item.id, item]));
		assert.strictEqual(byId.get('aura-team')?.name, 'Team');
		assert.strictEqual(byId.get('aura-team')?.kind, 'plugin');
		assert.strictEqual(byId.get('langgraph-orchestrator')?.name, 'LangGraph Orchestrator');
		assert.strictEqual(byId.get('langgraph-orchestrator')?.kind, 'plugin');
	});

	test('вью Team и LangGraph гейтятся флагом auraPlugin.<id>.enabled', () => {
		assert.strictEqual(viewWhen('aura-team', 'auraTeam', 'auraTeam.home'), 'auraPlugin.aura-team.enabled == true');
		assert.strictEqual(viewWhen('langgraph-orchestrator', 'auraOrchestrator', 'auraOrchestrator.home'), 'auraPlugin.langgraph-orchestrator.enabled == true');
	});

	test('плагины установлены по умолчанию: гейт не спрячет их у текущих пользователей', () => {
		const source = fs.readFileSync('src/vs/workbench/contrib/auraMarket/common/auraPluginService.ts', 'utf8');
		const match = /DEFAULT_INSTALLED_PLUGINS[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(source);
		assert.ok(match, 'не найден список плагинов, установленных по умолчанию');
		const ids = (match ? match[1] : '').split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(Boolean);
		// aggg — тоже по умолчанию: иначе у его карточки нет селектора версии ядра
		// (он рендерится только у установленного плагина) и команда с индикатором скрыты.
		for (const gated of ['aura-team', 'langgraph-orchestrator', 'aggg']) {
			assert.ok(ids.includes(gated), `«${gated}» гейтится, но не считается установленным по умолчанию`);
		}
	});

	test('Team активируется по командам прав — иначе AGGG 5.2 остаётся закрытой', () => {
		const pkg = readExtensionPackage('aura-team');
		const events: string[] = pkg.activationEvents ?? [];
		assert.ok(events.includes('onCommand:auraTeam.hasEntitlement'), 'нет onCommand:auraTeam.hasEntitlement');
		assert.ok(events.includes('onCommand:auraTeam.agggAgent'), 'нет onCommand:auraTeam.agggAgent');
	});

	test('LangGraph активируется по вью сайдбара', () => {
		const pkg = readExtensionPackage('langgraph-orchestrator');
		const events: string[] = pkg.activationEvents ?? [];
		assert.ok(events.includes('onView:auraOrchestrator.home'), 'нет onView:auraOrchestrator.home');
		const containers = pkg?.contributes?.viewsContainers?.activitybar ?? [];
		assert.ok(containers.some((item: { id: string }) => item.id === 'auraOrchestrator'), 'нет контейнера auraOrchestrator в activity bar');
	});

	test('команды Team и LangGraph гаснут вместе с плагином: enablement по флагу маркета', () => {
		for (const pluginId of ['aura-team', 'langgraph-orchestrator']) {
			const expected = auraPluginEnabledWhenClause(pluginId);
			const commands = contributedCommands(pluginId);
			assert.ok(commands.length > 0, `«${pluginId}»: не найдено ни одной команды`);
			for (const command of commands) {
				assert.strictEqual(command.enablement, expected, `«${pluginId}»: команда ${command.command} останется в палитре после отключения`);
			}
		}
	});

	test('инструмент чата agent_team гаснет вместе с оркестратором', () => {
		const tool = contributedTools('langgraph-orchestrator').find(item => item.toolReferenceName === AGENT_TEAM_TOOL_REFERENCE_NAME);
		assert.ok(tool, 'в манифесте оркестратора нет инструмента agent_team');
		assert.strictEqual(tool?.name, AGENT_TEAM_TOOL_ID, 'id инструмента не совпадает с AGENT_TEAM_TOOL_ID в чате');
		assert.strictEqual(tool?.when, AGENT_TEAM_ENABLED_WHEN, 'инструмент останется доступен модели после отключения плагина');
	});

	test('when инструмента и слэш-команды совпадает с флагом вью оркестратора', () => {
		assert.strictEqual(AGENT_TEAM_ENABLED_WHEN, viewWhen('langgraph-orchestrator', 'auraOrchestrator', 'auraOrchestrator.home'));
	});

	test('команда AGGG гаснет вместе с плагином (workbench-контрибуция)', () => {
		const source = fs.readFileSync('src/vs/workbench/contrib/aggg/browser/aggg.contribution.ts', 'utf8');
		assert.match(source, /precondition:\s*ContextKeyExpr\.equals\(auraPluginEnabledContextKey\('aggg'\),\s*true\)/, 'нет precondition у aggg.toggleBoost — команда останется в палитре после отключения AGGG');
	});

	test('слэш-команда /team гаснет вместе с оркестратором', () => {
		const source = fs.readFileSync('src/vs/workbench/contrib/auraApi/browser/auraApi.contribution.ts', 'utf8');
		assert.match(source, /name: AGENT_TEAM_SLASH_COMMAND,[\s\S]*?when: AGENT_TEAM_ENABLED_WHEN,/, 'нет when у /team — команда останется в подсказках чата после отключения оркестратора');
	});

	// --- Английский маркет: карточки и подписи ---

	test('английский overlay покрывает каждый пункт каталога — и ничего лишнего', () => {
		const ids = AURA_MARKET_ITEMS.map(item => item.id).sort();
		assert.deepStrictEqual(Object.keys(AURA_MARKET_ITEMS_EN).sort(), ids, 'перевод есть не для всех плагинов или ссылается на несуществующий id');
	});

	test('английская карточка не содержит кириллицы: имя, описание, документация, changelog', () => {
		for (const item of auraMarketItems('en')) {
			assert.ok(!CYRILLIC.test(item.name), `«${item.id}»: имя осталось русским — ${item.name}`);
			assert.ok(!CYRILLIC.test(item.description), `«${item.id}»: описание осталось русским`);
			assert.ok(!CYRILLIC.test(item.docs ?? ''), `«${item.id}»: документация осталась русской`);
			assert.ok(!CYRILLIC.test(item.size ?? ''), `«${item.id}»: размер остался русским`);
			assert.ok(!CYRILLIC.test(item.sizeNote ?? ''), `«${item.id}»: предупреждение о toolchain осталось русским`);
			for (const version of item.versions ?? []) {
				for (const line of version.changelog) {
					assert.ok(!CYRILLIC.test(line), `«${item.id}» ${version.version}: changelog остался русским — ${line}`);
				}
			}
		}
	});

	test('английский changelog покрывает все версии с тем же числом строк', () => {
		const base = new Map(AURA_MARKET_ITEMS.map(item => [item.id, item]));
		for (const item of auraMarketItems('en')) {
			const source = base.get(item.id);
			assert.ok(source, `«${item.id}»: карточки нет в русском каталоге`);
			const sourceVersions = new Map((source.versions ?? []).map(version => [version.version, version]));
			assert.deepStrictEqual((item.versions ?? []).map(v => v.version), (source.versions ?? []).map(v => v.version), `«${item.id}»: список версий разъехался с оригиналом`);
			for (const version of item.versions ?? []) {
				const ruLines = sourceVersions.get(version.version)?.changelog.length;
				assert.strictEqual(version.changelog.length, ruLines, `«${item.id}» ${version.version}: в переводе ${version.changelog.length} строк вместо ${ruLines}`);
			}
		}
	});

	test('русский каталог не пересобирается: auraMarketItems("ru") отдаёт те же пункты', () => {
		const items = auraMarketItems('ru');
		assert.strictEqual(items.length, AURA_MARKET_ITEMS.length);
		items.forEach((item, index) => assert.strictEqual(item, AURA_MARKET_ITEMS[index], 'русский каталог должен отдаваться как есть, а не копией'));
		// Кеш по языку: один и тот же массив, иначе каждая перерисовка собирает мусор заново.
		assert.strictEqual(auraMarketItems('en'), auraMarketItems('en'));
	});

	test('английская карточка сохраняет версию, размер и автора оригинала', () => {
		for (const item of auraMarketItems('en')) {
			const source = AURA_MARKET_ITEMS.find(base => base.id === item.id)!;
			assert.strictEqual(item.version, source.version, `«${item.id}»: version потерян при переводе`);
			assert.strictEqual(item.builtinId, source.builtinId, `«${item.id}»: builtinId потерян при переводе`);
			assert.strictEqual(item.author, source.author, `«${item.id}»: автор потерян при переводе`);
			assert.strictEqual(item.kind, source.kind, `«${item.id}»: тип пункта потерян при переводе`);
		}
	});

	test('наборы строк интерфейса ru и en совпадают по составу', () => {
		const ru = auraMarketText('ru') as unknown as Record<string, unknown>;
		const en = auraMarketText('en') as unknown as Record<string, unknown>;
		assert.deepStrictEqual(Object.keys(en).sort(), Object.keys(ru).sort(), 'в одном из наборов не хватает строки интерфейса');
		for (const key of Object.keys(ru)) {
			assert.strictEqual(typeof en[key], typeof ru[key], `«${key}»: в переводах разный тип значения`);
		}
	});

	test('панель маркета не держит текст в себе: либо набор строк, либо сервис языка', () => {
		const source = fs.readFileSync('src/vs/workbench/contrib/auraMarket/browser/auraMarketEditorPane.ts', 'utf8');
		// Комментарии кириллицу содержать могут (это код-ревью), а строковые литералы — нет.
		const code = source.split('\n').filter(line => {
			const trimmed = line.trimStart();
			return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
		});
		const russian = code.filter(line => /['"`][^'"`]*[А-Яа-яЁё]/.test(line));
		assert.deepStrictEqual(russian, [], 'текст интерфейса должен идти через auraMarketText/auraMarketItems, а не хардкодиться в панели');
		assert.match(source, /languageService\.onDidChange\(/, 'без подписки смена языка не доедет до уже открытой вкладки маркета');
	});

	test('английский интерфейс маркета без кириллицы — включая текст с именем плагина', () => {
		const en: IAuraMarketText = auraMarketText('en');
		for (const [key, value] of Object.entries(en)) {
			if (typeof value === 'string') {
				assert.ok(!CYRILLIC.test(value), `«${key}»: строка осталась русской — ${value}`);
			}
		}
		// Функции вклеивают имя плагина: проверяем их вывод, а не только сигнатуру.
		const composed = [
			en.confirmInstall('Team', '1 GB of tools'),
			en.notBundled('Team'),
			en.installed('Team'),
			en.confirmUninstall('Team'),
			en.removed('Team'),
			en.docsReaderLabel('Team'),
			en.versions(3),
		];
		for (const line of composed) {
			assert.ok(!CYRILLIC.test(line), `английский текст с именем плагина остался русским — ${line}`);
		}
	});
});
