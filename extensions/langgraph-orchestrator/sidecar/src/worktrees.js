'use strict';

const path = require('node:path');

/**
 * Изоляция воркеров (Этап 4.1): каждый узел работает в своём git worktree
 * на своей ветке от базового коммита запуска. Здесь — только чистые правила
 * именования и путей, без побочных эффектов: git-операции исполняет расширение
 * через tool.invoke, сайдкар их только планирует.
 */

/** Каталог рабочих деревьев внутри репозитория (в .gitignore). */
const WORKTREES_DIR = ['.aura', 'worktrees'];

/**
 * Слаг для git-ref и имени папки: оставляем латиницу/цифры/._-, остальное
 * схлопываем в дефис. id узлов вида `coder#1.0` становятся `coder-1.0`.
 */
function slug(value, fallback = 'x') {
	const text = String(value == null ? '' : value).trim().toLowerCase();
	const cleaned = text.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
	return (cleaned || fallback).slice(0, 80);
}

/**
 * Ветки запуска и узлов — СОСЕДИ, а не родитель/ребёнок: git не позволяет ref
 * быть одновременно и листом, и папкой, поэтому `aura/<run>` + `aura/<run>/<node>`
 * конфликтовал бы при создании. Layout: `aura/<run>/run` и `aura/<run>/nodes/<node>`.
 */
function runBranch(runId) {
	return `aura/${slug(runId, 'run')}/run`;
}

/** Ветка одного узла (сестра run-ветки внутри того же namespace). */
function nodeBranch(runId, nodeId) {
	return `aura/${slug(runId, 'run')}/nodes/${slug(nodeId, 'node')}`;
}

/** Относительный путь рабочего дерева узла. */
function worktreeRelPath(runId, nodeId) {
	return path.join(...WORKTREES_DIR, slug(runId, 'run'), slug(nodeId, 'node'));
}

/** Абсолютный путь рабочего дерева узла. */
function worktreePath(workspaceRoot, runId, nodeId) {
	return path.join(String(workspaceRoot || ''), worktreeRelPath(runId, nodeId));
}

/** Служебное дерево run-ветки: в нём супервизор мёржит узлы. */
function runWorktreeRelPath(runId) {
	return path.join(...WORKTREES_DIR, slug(runId, 'run'), '__run');
}

function runWorktreePath(workspaceRoot, runId) {
	return path.join(String(workspaceRoot || ''), runWorktreeRelPath(runId));
}

/**
 * Пустой ли план правок: worktree нужен, только если воркер что-то изменит.
 * Для узлов-только-чтения (search/review/security) изоляция избыточна.
 */
function needsIsolation(assignment) {
	const kind = assignment && assignment.kind;
	return kind !== 'search' && kind !== 'review' && kind !== 'security';
}

module.exports = {
	slug,
	runBranch,
	nodeBranch,
	worktreeRelPath,
	worktreePath,
	runWorktreeRelPath,
	runWorktreePath,
	needsIsolation,
	WORKTREES_DIR,
};
