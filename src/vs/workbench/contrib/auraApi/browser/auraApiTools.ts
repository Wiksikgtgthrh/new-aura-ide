/*---------------------------------------------------------------------------------------------
 *  API Keys — файловые инструменты для чат-агента.
 *  Без них BYOK-модель может только писать код текстом в чат: здесь она получает
 *  возможность читать, создавать и перезаписывать файлы внутри рабочей папки.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { CountTokensCallback, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource, ToolProgress } from '../../chat/common/tools/languageModelToolsService.js';

export const AURA_READ_FILE_TOOL_ID = 'aura_readFile';
export const AURA_WRITE_FILE_TOOL_ID = 'aura_writeFile';
export const AURA_LIST_FILES_TOOL_ID = 'aura_listFiles';

/** Инструменты не должны выходить за пределы рабочих папок и тонуть в служебных каталогах. */
const IGNORED_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.vscode-test']);
const MAX_FILE_READ_BYTES = 100 * 1024;
const MAX_LIST_ENTRIES = 400;

/** Резолвит относительный путь модели в URI внутри рабочей папки. Пути вне workspace запрещены. */
function resolveWorkspacePath(workspaceContext: IWorkspaceContextService, rawPath: unknown): URI {
	const folders = workspaceContext.getWorkspace().folders;
	if (!folders.length) {
		throw new Error(localize('apiKeys.tools.noWorkspace', "В окне не открыта рабочая папка — инструменты файлов недоступны."));
	}
	if (typeof rawPath !== 'string' || !rawPath.trim()) {
		throw new Error(localize('apiKeys.tools.noPath', "Параметр path обязателен."));
	}
	const path = rawPath.trim().replace(/^[\\/]+/, '');
	const target = URI.joinPath(folders[0].uri, path);
	const root = folders[0].uri;
	// Защита от выхода за пределы workspace через ../
	if (!(target.scheme === root.scheme && target.authority === root.authority && (target.path === root.path || target.path.startsWith(root.path.endsWith('/') ? root.path : root.path + '/')))) {
		throw new Error(localize('apiKeys.tools.outsideWorkspace', "Путь «{0}» вне рабочей папки — доступ запрещён.", path));
	}
	return target;
}

export class AuraReadFileTool implements IToolImpl {
	static readonly data: IToolData = {
		id: AURA_READ_FILE_TOOL_ID,
		toolReferenceName: 'read_file',
		displayName: localize('apiKeys.tools.readFile', "Read File"),
		userDescription: localize('apiKeys.tools.readFileUser', "Читает файл из рабочей папки"),
		modelDescription: 'Read a text file from the workspace. Always read a file before modifying it, so edits are based on the real current content. Paths are relative to the workspace root.',
		source: ToolDataSource.Internal,
		canBeReferencedInPrompt: true,
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path to the file, relative to the workspace root (e.g. "src/app.ts").' },
			},
			required: ['path'],
		},
	};

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const uri = resolveWorkspacePath(this.workspaceContext, (invocation.parameters as { path?: string }).path);
		const stat = await this.fileService.resolve(uri).catch(() => undefined);
		if (!stat) {
			throw new Error(localize('apiKeys.tools.fileNotFound', "Файл не найден: {0}", (invocation.parameters as { path?: string }).path));
		}
		if (stat.isDirectory) {
			throw new Error(localize('apiKeys.tools.isDirectory', "«{0}» — это папка, а не файл. Используйте list_files.", (invocation.parameters as { path?: string }).path));
		}
		const content = await this.fileService.readFile(uri);
		let text = content.value.toString();
		if (content.value.byteLength > MAX_FILE_READ_BYTES) {
			text = text.slice(0, MAX_FILE_READ_BYTES) + `\n… [обрезано: файл ${content.value.byteLength} байт, показаны первые ${MAX_FILE_READ_BYTES}]`;
		}
		return { content: [{ kind: 'text', value: text }] };
	}
}

export class AuraWriteFileTool implements IToolImpl {
	static readonly data: IToolData = {
		id: AURA_WRITE_FILE_TOOL_ID,
		toolReferenceName: 'write_file',
		displayName: localize('apiKeys.tools.writeFile', "Write File"),
		userDescription: localize('apiKeys.tools.writeFileUser', "Создаёт или перезаписывает файл в рабочей папке"),
		modelDescription: 'Create a new file or fully overwrite an existing file in the workspace with the given content. Missing parent directories are created automatically. Use this instead of printing code in chat — the user expects real files. For large edits to existing files prefer writing the complete new file content.',
		source: ToolDataSource.Internal,
		canBeReferencedInPrompt: true,
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path to the file, relative to the workspace root.' },
				content: { type: 'string', description: 'Full file content to write.' },
			},
			required: ['path', 'content'],
		},
	};

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as { path?: string; content?: string };
		const uri = resolveWorkspacePath(this.workspaceContext, params.path);
		await this.fileService.createFolder(dirname(uri));
		await this.fileService.writeFile(uri, VSBuffer.fromString(params.content ?? ''));
		return { content: [{ kind: 'text', value: localize('apiKeys.tools.wroteFile', "Файл записан: {0} ({1} байт)", params.path ?? '', (params.content ?? '').length) }] };
	}
}

export class AuraListFilesTool implements IToolImpl {
	static readonly data: IToolData = {
		id: AURA_LIST_FILES_TOOL_ID,
		toolReferenceName: 'list_files',
		displayName: localize('apiKeys.tools.listFiles', "List Files"),
		userDescription: localize('apiKeys.tools.listFilesUser', "Показывает структуру папки в рабочей области"),
		modelDescription: 'List files and directories inside a workspace folder (non-recursive). Use it to explore the project structure before reading or writing files. Paths are relative to the workspace root; omit path to list the root.',
		source: ToolDataSource.Internal,
		canBeReferencedInPrompt: true,
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Folder path relative to the workspace root. Omit for the root.' },
			},
		},
	};

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const uri = resolveWorkspacePath(this.workspaceContext, (invocation.parameters as { path?: string }).path ?? '.');
		const stat = await this.fileService.resolve(uri).catch(() => undefined);
		if (!stat?.isDirectory) {
			throw new Error(localize('apiKeys.tools.dirNotFound', "Папка не найдена: {0}", (invocation.parameters as { path?: string }).path ?? '.'));
		}
		const lines: string[] = [];
		for (const child of stat.children ?? []) {
			if (lines.length >= MAX_LIST_ENTRIES) { lines.push('… [обрезано]'); break; }
			if (child.isDirectory && IGNORED_DIRS.has(child.name)) { lines.push(`${child.name}/ [skipped]`); continue; }
			lines.push(child.isDirectory ? `${child.name}/` : child.name);
		}
		return { content: [{ kind: 'text', value: lines.join('\n') || '(пустая папка)' }] };
	}
}
