/*---------------------------------------------------------------------------------------------
 *  Aura Market — центральная вкладка (EditorInput).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

export class AuraMarketEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.auraMarket';
	static readonly RESOURCE = URI.from({ scheme: 'aura-market', path: 'market' });

	override get typeId(): string { return AuraMarketEditorInput.ID; }
	override get editorId(): string { return this.typeId; }
	override get resource(): URI { return AuraMarketEditorInput.RESOURCE; }

	override getName(): string { return 'Aura Market'; }

	override matches(other: unknown): boolean {
		return other instanceof AuraMarketEditorInput;
	}
}

export class AuraMarketEditorInputSerializer implements IEditorSerializer {
	canSerialize(): boolean { return true; }
	serialize(): string { return ''; }
	deserialize(instantiationService: IInstantiationService): AuraMarketEditorInput {
		return instantiationService.createInstance(AuraMarketEditorInput);
	}
}
