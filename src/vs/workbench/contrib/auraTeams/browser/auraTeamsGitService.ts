/*---------------------------------------------------------------------------------------------
 *  Aura Teams — git-операции: умный коммит через модель Aura, контрольные точки, история задачи.
 *  Репозиторий доступен только через команды расширения git (git.api.*), см. extensions/git.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ILanguageModelsService, ChatMessageRole, getTextResponseFromStream } from '../../chat/common/languageModels.js';
import { IAuraTeamsService } from '../common/auraTeamsService.js';
import {
	IAuraCheckpoint, IAuraCommit, buildSmartCommitPrompt, checkpointTagName, checkpointsFromRefs, cleanCommitMessage,
	commitSubject, commitsForTask, withTaskTrailer,
} from '../common/auraTeamsGit.js';

export const IAuraTeamsGitService = createDecorator<IAuraTeamsGitService>('auraTeamsGitService');

export interface IAuraTeamsGitService {
	readonly _serviceBrand: undefined;
	/** Сгенерировать сообщение по diff моделью Aura и подставить в поле коммита SCM. */
	smartCommit(taskId?: string): Promise<void>;
	/** Тег aura/checkpoint/<время> на HEAD; незакоммиченные правки уходят в stash с тем же именем. */
	createCheckpoint(): Promise<void>;
	/** Выбрать контрольную точку и откатиться на неё (reset --hard с авто-stash). */
	restoreCheckpoint(): Promise<void>;
	/** Коммиты задачи по трейлеру Aura-Task. */
	taskHistory(taskId: string): Promise<IAuraCommit[]>;
	/** Откатить все коммиты задачи обратными коммитами, новые первыми. */
	revertTask(taskId: string): Promise<void>;
}

interface IApiRef { name?: string; commit?: string; type?: string }

export class AuraTeamsGitService implements IAuraTeamsGitService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@IProgressService private readonly progressService: IProgressService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IAuraTeamsService private readonly teams: IAuraTeamsService,
	) { }

	/** Корень репозитория: первая папка workspace, у которой git знает репозиторий. */
	private async repositoryUri(): Promise<string | undefined> {
		let repos: string[] | undefined;
		try {
			repos = await this.commandService.executeCommand<string[]>('git.api.getRepositories');
		} catch {
			return undefined;
		}
		if (!repos || repos.length === 0) {
			return undefined;
		}
		const folders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.toString());
		return repos.find(r => folders.some(f => f === r || f.startsWith(`${r}/`))) ?? repos[0];
	}

	private async requireRepository(): Promise<string | undefined> {
		const uri = await this.repositoryUri();
		if (!uri) {
			this.notificationService.warn('Git-репозиторий не найден: откройте папку с инициализированным git.');
		}
		return uri;
	}

	async smartCommit(taskId?: string): Promise<void> {
		const repo = await this.requireRepository();
		if (!repo) {
			return;
		}
		let diff = await this.commandService.executeCommand<string>('git.api.diff', repo, true) ?? '';
		let scope = 'staged';
		if (!diff.trim()) {
			diff = await this.commandService.executeCommand<string>('git.api.diff', repo, false) ?? '';
			scope = 'working';
		}
		if (!diff.trim()) {
			this.notificationService.info('Нет изменений для коммита.');
			return;
		}

		const modelIds = await this.languageModelsService.selectLanguageModels({ vendor: 'auraApi' });
		const modelId = modelIds[0] ?? (await this.languageModelsService.selectLanguageModels({}))[0];
		if (!modelId) {
			this.notificationService.warn('Нет доступной модели: добавьте и проверьте ключ в Aura API.');
			return;
		}

		const task = taskId ? this.teams.getTask(taskId) : undefined;
		const cts = new CancellationTokenSource();
		try {
			const message = await this.progressService.withProgress(
				{ location: ProgressLocation.Notification, title: 'Aura: сочиняю сообщение коммита…', cancellable: true },
				async () => this.generateMessage(modelId, buildSmartCommitPrompt(diff, task?.title), cts.token),
				() => cts.cancel(),
			);
			if (cts.token.isCancellationRequested || !message) {
				return;
			}
			const final = task ? withTaskTrailer(message, task.id) : message;
			await this.commandService.executeCommand('git.api.setInputBox', repo, final);
			await this.commandService.executeCommand('workbench.view.scm');
			if (scope === 'working') {
				this.notificationService.info('Сообщение подставлено. Изменения не застейджены — при коммите git предложит добавить все.');
			}
		} catch (e) {
			this.notificationService.error(`Умный коммит не удался: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			cts.dispose();
		}
	}

	private async generateMessage(modelId: string, prompt: string, token: CancellationToken): Promise<string> {
		const response = await this.languageModelsService.sendChatRequest(
			modelId,
			undefined,
			[{ role: ChatMessageRole.User, content: [{ type: 'text', value: prompt }] }],
			{},
			token,
		);
		return cleanCommitMessage(await getTextResponseFromStream(response));
	}

	async createCheckpoint(): Promise<void> {
		const repo = await this.requireRepository();
		if (!repo) {
			return;
		}
		const tag = checkpointTagName(Date.now());
		try {
			const dirty = (await this.commandService.executeCommand<string>('git.api.diff', repo, false) ?? '').trim().length > 0
				|| (await this.commandService.executeCommand<string>('git.api.diff', repo, true) ?? '').trim().length > 0;
			if (dirty) {
				// Незакоммиченное уходит в stash с именем точки, чтобы её можно было вернуть целиком
				await this.commandService.executeCommand('git.api.createStash', repo, tag, true);
			}
			await this.commandService.executeCommand('git.api.tag', repo, tag, 'Aura checkpoint');
			if (dirty) {
				await this.commandService.executeCommand('git.stashPopLatest');
			}
			this.notificationService.info(`Контрольная точка создана: ${tag.slice('aura/checkpoint/'.length)}${dirty ? ' (незакоммиченные правки сохранены в stash и возвращены)' : ''}.`);
		} catch (e) {
			this.notificationService.error(`Не удалось создать контрольную точку: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async listCheckpoints(repo: string): Promise<IAuraCheckpoint[]> {
		const refs = await this.commandService.executeCommand<IApiRef[]>('git.api.getRefs', repo, { pattern: 'refs/tags/aura/checkpoint/' }) ?? [];
		return checkpointsFromRefs(refs, Date.now());
	}

	async restoreCheckpoint(): Promise<void> {
		const repo = await this.requireRepository();
		if (!repo) {
			return;
		}
		const checkpoints = await this.listCheckpoints(repo);
		if (checkpoints.length === 0) {
			this.notificationService.info('Контрольных точек пока нет. Создайте первую командой «Aura Teams: Контрольная точка».');
			return;
		}
		const picked = await this.quickInputService.pick(
			checkpoints.map(c => ({ label: `$(history) ${c.label}`, description: c.commit.slice(0, 7), detail: c.tag, checkpoint: c })),
			{ placeHolder: 'Откатиться к контрольной точке', matchOnDetail: true },
		);
		if (!picked) {
			return;
		}
		const { confirmed } = await this.dialogService.confirm({
			message: `Откатить рабочую копию к точке «${picked.checkpoint.label}»?`,
			detail: 'Незакоммиченные правки будут сохранены в stash. История коммитов после точки останется доступна через reflog.',
			primaryButton: 'Откатить',
			type: 'warning',
		});
		if (!confirmed) {
			return;
		}
		try {
			const dirty = (await this.commandService.executeCommand<string>('git.api.diff', repo, false) ?? '').trim().length > 0;
			if (dirty) {
				await this.commandService.executeCommand('git.api.createStash', repo, `before-restore ${picked.checkpoint.tag}`, true);
			}
			await this.commandService.executeCommand('git.api.reset', repo, picked.checkpoint.commit, true);
			this.notificationService.info(`Откат выполнен: ${picked.checkpoint.tag}.`);
		} catch (e) {
			this.notificationService.error(`Откат не удался: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async taskHistory(taskId: string): Promise<IAuraCommit[]> {
		const repo = await this.repositoryUri();
		if (!repo) {
			return [];
		}
		// grep по трейлеру — git отдаёт только нужные коммиты, фильтр в commitsForTask страхует от совпадений по подстроке
		const log = await this.commandService.executeCommand<IAuraCommit[]>('git.api.log', repo, { maxEntries: 200, grep: `Aura-Task: ${taskId}` }) ?? [];
		return commitsForTask(log, taskId);
	}

	async revertTask(taskId: string): Promise<void> {
		const repo = await this.requireRepository();
		if (!repo) {
			return;
		}
		const task = this.teams.getTask(taskId);
		const commits = await this.taskHistory(taskId);
		if (commits.length === 0) {
			this.notificationService.info('У задачи нет коммитов с трейлером Aura-Task — откатывать нечего.');
			return;
		}
		const { confirmed } = await this.dialogService.confirm({
			message: `Откатить задачу «${task?.title ?? taskId}» — ${commits.length} коммитов?`,
			detail: `Будут созданы обратные коммиты:\n${commits.map(c => `• ${c.hash.slice(0, 7)} ${commitSubject(c.message)}`).join('\n')}`,
			primaryButton: 'Откатить',
			type: 'warning',
		});
		if (!confirmed) {
			return;
		}
		let done = 0;
		try {
			for (const c of commits) { // журнал отдаёт новые первыми — именно в этом порядке revert безопасен
				await this.commandService.executeCommand('git.api.revertCommit', repo, c.hash);
				done++;
			}
			this.notificationService.info(`Задача откачена: ${done} обратных коммитов.`);
		} catch (e) {
			this.notificationService.error(`Откат остановлен после ${done} из ${commits.length}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

registerSingleton(IAuraTeamsGitService, AuraTeamsGitService, InstantiationType.Delayed);
