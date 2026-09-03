/*---------------------------------------------------------------------------------------------
 *  Aura Teams — центральная вкладка канбан-доски (EditorInput).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

export class AuraTeamsEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.auraTeams';
	static readonly RESOURCE = URI.from({ scheme: 'aura-teams', path: 'board' });

	override get typeId(): string { return AuraTeamsEditorInput.ID; }
	override get editorId(): string { return this.typeId; }
	override get resource(): URI { return AuraTeamsEditorInput.RESOURCE; }

	override getName(): string { return 'Aura Teams'; }

	override matches(other: unknown): boolean {
		return other instanceof AuraTeamsEditorInput;
	}
}

export class AuraTeamsEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(): string { return ''; }
	deserialize(instantiationService: IInstantiationService): AuraTeamsEditorInput {
		return instantiationService.createInstance(AuraTeamsEditorInput);
	}
}
