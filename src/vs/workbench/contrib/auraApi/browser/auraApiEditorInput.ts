/*---------------------------------------------------------------------------------------------
 *  API — центральная вкладка менеджера ключей (EditorInput).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { localize } from '../../../../nls.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

export const apiKeysEditorIcon = registerIcon('api-keys-editor-icon', Codicon.key, localize('apiKeysEditorIcon', 'Icon of the API keys editor.'));

export class AuraApiEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.apiKeys';
	static readonly RESOURCE = URI.from({ scheme: 'api-keys', path: 'manager' });

	override get typeId(): string { return AuraApiEditorInput.ID; }
	override get editorId(): string { return this.typeId; }
	override get resource(): URI { return AuraApiEditorInput.RESOURCE; }

	override getName(): string { return 'API'; }
	override getIcon() { return apiKeysEditorIcon; }

	override matches(other: unknown): boolean {
		return other instanceof AuraApiEditorInput;
	}
}

export class AuraApiEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(): string { return ''; }
	deserialize(instantiationService: IInstantiationService): AuraApiEditorInput {
		return instantiationService.createInstance(AuraApiEditorInput);
	}
}
