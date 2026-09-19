/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type TeamRole = 'owner' | 'maintainer' | 'dev' | 'viewer';
export type TaskStatus = 'todo' | 'doing' | 'review' | 'done';

export interface User { id: string; email: string; displayName: string; }
export interface Team { id: string; name: string; role: TeamRole; }
export interface Member { id: string; displayName: string; email: string; role: TeamRole; online: boolean; }
export interface Project { id: string; teamId: string; name: string; gitUrl?: string; archiveId?: string; ownerId?: string; defaultBranch: string; }
export interface TeamTask { id: string; teamId: string; title: string; description: string; status: TaskStatus; assigneeId?: string; assigneeName?: string; position: number; dueAt?: string; }
export interface Session { user: User; teams: Team[]; }
export interface BoardSnapshot { members: Member[]; projects: Project[]; tasks: TeamTask[]; }

/** Событие живой ленты команды (из audit_log сервера). */
export interface TeamActivityEvent {
	action: string;
	targetType?: string;
	targetId?: string;
	details: Record<string, unknown>;
	createdAt: string;
	userId: string;
	userName: string;
	taskTitle?: string;
}

/** Компактный снимок команды для сайдбара. */
export interface TeamSummary {
	members: Member[];
	myTasks: Array<{ id: string; title: string; status: TaskStatus; dueAt?: string }>;
	projects: Array<{ id: string; name: string; defaultBranch: string; gitUrl?: string }>;
}
export interface TeamApiKey { id: string; label: string; keyHint: string; provider: string; accessRole: TeamRole; priority: number; groupId?: string | null; pingMs?: number | null; lastCheckedAt?: string | null; disabledAt?: string; createdAt: string; }
export interface KeyGroup { id: string; name: string; priority: number; createdAt: string; }

export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number; }
export interface DeviceAuthorization { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number; }

/** Локальный профиль пользователя (хранится в globalState, без сервера). */
export interface Profile {
	id: string;
	nickname: string;
	email: string;
	description: string;
	avatarColor: string;
	avatar?: string;
	createdAt: number;
}

export interface GitChangeInfo { path: string; kind: 'index' | 'working' | 'untracked'; }
export interface GitCommitInfo { hash: string; message: string; author?: string; date?: string; }
export interface GitBranchInfo { name: string; current: boolean; ahead?: number; behind?: number; }
export interface GitSnapshot {
	path?: string;
	branch: string;
	remotes: string[];
	changes: GitChangeInfo[];
	commits: GitCommitInfo[];
	/** Локальные ветки с флагом текущей и ahead/behind относительно upstream. */
	branches?: GitBranchInfo[];
	/** Насколько текущая ветка опережает/отстаёт от upstream. */
	ahead?: number;
	behind?: number;
}

/** Полный снимок состояния, который расширение отдаёт webview. */
export interface AuraState {
	profile: Profile;
	session?: Session;
	teamId?: string;
	board?: BoardSnapshot;
	keys?: TeamApiKey[];
	keyGroups?: KeyGroup[];
	git?: GitSnapshot;
	demoMode: boolean;
	simpleMode: boolean;
	serverUrl: string;
	signedIn: boolean;
	/** Подключён ли GitHub (сохранён personal access token). */
	githubConnected?: boolean;
	/** Язык интерфейса IDE (vscode.env.language) для локализации webview. */
	ideLanguage?: string;
	/** Язык UI Team ('ru' | 'en' | 'auto' — из настройки team.ui.language). */
	uiLanguage?: string;
	/** Живая лента последних событий команды. */
	activity?: TeamActivityEvent[];
	/** Локально скрытые события ленты (id `createdAt|action|userId`), хранятся в globalState. */
	dismissedActivity?: string[];
	/** Снимок команды: участники+online, мои задачи, проекты. */
	summary?: TeamSummary;
}
