/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

export class AgggEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.aggg';
	static readonly RESOURCE = URI.from({ scheme: 'aggg', path: 'manager' });

	override get typeId(): string { return AgggEditorInput.ID; }
	override get editorId(): string { return this.typeId; }
	override get resource(): URI { return AgggEditorInput.RESOURCE; }

	override getName(): string { return 'AGGG'; }
	override getIcon() { return undefined; }

	override matches(other: unknown): boolean {
		return other instanceof AgggEditorInput;
	}
}

export class AgggEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(): string { return ''; }
	deserialize(instantiationService: IInstantiationService): AgggEditorInput {
		return instantiationService.createInstance(AgggEditorInput);
	}
}
