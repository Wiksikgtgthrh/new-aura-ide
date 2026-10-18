# DONE-b1fix2 — закрытие ZAN-zan2-b1 (REQUEST_CHANGES)

**Дата:** 2026-10-18 · **Зона:** `extensions/aura-kotlin` · Ничего не закоммичено (`git status`: 3 файла зоны, out/ — gitignore).

## Гейты (воспроизводимо, из корня репо)

| Команда | Результат |
|---|---|
| `npx tsc --noEmit -p extensions/aura-kotlin/tsconfig.json` | **exit 0** |
| `npx tsc -p …` (эмит) | exit 0; `out/deviceScreen.js` свежий, правки в эмите (headerEnd+1 → out:283, skipUntilKey → out:491–576, configure ×2 → out:552,567) |
| `node docs/swarm/zan2-b1-smoke.cjs` | **exit 0, 14/14 PASS** (S1: ровно 3 кадра + video-config; S1b многослайсный AU цел; S2/S2b, S3, S4/S4b, S5a–e) |
| PGlite/drizzle-смоуки из шаблона | файлов нет (`ls docs/swarm \| grep -i smoke` → только `zan2-b1-smoke.cjs`) — прогонять нечего, подтверждено и Заном |

## Пункты «Минимум к следующей итерации»

1. **BLOCKER: off-by-one в isFirstSlice — ЗАКРЫТ.** `src/deviceScreen.ts:216`: читается `buf[headerEnd + 1] & 0x80` (slice header, не NAL-заголовок F|NRI|Type). Доказательство: смоук S1/S1b/S1c/S1d/S2/S2b — зелёные, конвейер эмитит 3 кадра против 0 до правки.
2. **MAJOR: feedChunk reset() без configure — ЗАКРЫТ.** `src/deviceScreen.ts:471-499`: флаг `skipUntilKey` (:406) при перегрузке >60 → `reset()` + повторный `configure({codec: lastCodec…})` (:481-483; lastCodec хранится с :445); дроп ВСЕХ чанков до первого key независимо от очереди (:488-491), комментарий переписан под спеку W3C.
3. **MAJOR: 180-с рестарт после поворота — ЗАКРЫТ.** Флаг `rotated` (:46), ставится в `afterRotate` (:286), exit-рестарт зовёт `startVideo(this.rotated)` (:163) — `--size` после поворота не передаётся до конца сессии.
4. **Порог тапа — ЗАКРЫТ.** `src/deviceScreen.ts:591`: порядок `naturalWidth → width → devSize → rect`, как в `toDevice` (:517).

## По остатку (minor/nit из ZAN-zan2-b1)

5. **Врущий комментарий `android.ts:466` — ЗАКРЫТ.** `:466-469`: написано прямо — wm отдаёт оба размера в НАТИВНОЙ ориентации, оси после поворота не меняются.
6. **canvas 300×150 до первого кадра (minor 5) — ЗАКРЫТ.** `setMode('video')` перенесён из `resetDecoder` в output-колбэк первого декодированного кадра (:457) — скрытый canvas событий не получает.
7. **`img.onload → layout()` (minor 6) — ЗАКРЫТ.** `:617`: `img.addEventListener('load', layout)`.
8. **Стейл `out/*.js.map` от Oct 15 (minor 7) — ЗАКРЫТ.** sourceMap в tsconfig нет → мапы-сироты; 20 шт. удалены, билд их не регенерит (проверено эмитом).

## Не закрыто

- MINOR: интерполяция `${t(...)}` в HTML-атрибуты без escape (ZAN-10 хвост) — вне «минимума», нит по ревью.

**Итог: 4/4 пункта минимума + 4 minor закрыты, смоук зелёный, exit 0.**
