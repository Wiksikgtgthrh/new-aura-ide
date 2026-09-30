'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { MemorySaver } = require('@langchain/langgraph-checkpoint');

/**
 * Персистентный чекпоинтер: наследует MemorySaver и после каждого put/putWrites
 * сохраняет хранилище в JSON-файл. Даёт машине времени (history/rewind/patchState)
 * память между рестартами сайдкара: граф, остановленный interrupt'ом, можно
 * докатить после перезапуска IDE. Binary-значения serde кодируются в base64 —
 * в практике это json-строки, но защита не помешает.
 */
class FileSaver extends MemorySaver {
	constructor(filePath, serde) {
		super(serde);
		this.filePath = String(filePath || '');
		this.load();
	}

	load() {
		if (!this.filePath) {
			return;
		}
		try {
			const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
			if (raw && typeof raw === 'object') {
				this.storage = reviveBytes(raw.storage) || {};
				this.writes = reviveBytes(raw.writes) || {};
			}
		} catch {
			// файла нет или он бит — начинаем с пустого хранилища
		}
	}

	save() {
		if (!this.filePath) {
			return;
		}
		const data = JSON.stringify({ storage: this.storage, writes: this.writes }, (key, value) => {
			if (value instanceof Uint8Array) {
				return { __bytes: Buffer.from(value).toString('base64') };
			}
			return value;
		});
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.tmp`;
		fs.writeFileSync(tmp, data);
		fs.renameSync(tmp, this.filePath);
	}

	async put(config, checkpoint, metadata) {
		const result = await super.put(config, checkpoint, metadata);
		this.save();
		return result;
	}

	async putWrites(config, writes, taskId) {
		await super.putWrites(config, writes, taskId);
		this.save();
	}
}

/** Рекурсивно превращает {__bytes: base64} обратно в Uint8Array. */
function reviveBytes(value) {
	if (Array.isArray(value)) {
		return value.map(reviveBytes);
	}
	if (value && typeof value === 'object') {
		if (typeof value.__bytes === 'string') {
			return new Uint8Array(Buffer.from(value.__bytes, 'base64'));
		}
		const out = {};
		for (const key of Object.keys(value)) {
			out[key] = reviveBytes(value[key]);
		}
		return out;
	}
	return value;
}

module.exports = { FileSaver };
