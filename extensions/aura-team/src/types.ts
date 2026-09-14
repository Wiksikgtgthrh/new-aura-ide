/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type TeamRole = 'owner' | 'maintainer' | 'dev' | 'viewer';
export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'review' | 'done';

export interface User { id: string; email: string; displayName: string; }
export interface Team { id: string; name: string; role: TeamRole; }
export interface Member { id: string; displayName: string; email: string; role: TeamRole; online: boolean; }
export interface Project { id: string; teamId: string; name: string; gitUrl?: string; archiveId?: string; defaultBranch: string; }
export interface TeamTask { id: string; teamId: string; title: string; description: string; status: TaskStatus; assigneeId?: string; assigneeName?: string; position: number; dueAt?: string; }
export interface Session { user: User; teams: Team[]; }
export interface BoardSnapshot { members: Member[]; projects: Project[]; tasks: TeamTask[]; }
export interface TeamApiKey { id: string; label: string; keyHint: string; provider: string; accessRole: TeamRole; priority: number; disabledAt?: string; createdAt: string; }

export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number; }
export interface DeviceAuthorization { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number; }
