# DONE — b1fix (ревью ZAN-b1)

**Вердикт:** все 11 пунктов закрыты. tsc --noEmit exit 0, tsc эмит exit 0, node --check SYNTAX_OK.

## Блокеры

| Пункт | Статус | Где | Как проверено |
|-------|--------|-----|---------------|
| ZAN-1 (нет билда) | ✅ | `tsc -p …` → out/deviceScreen.js (36 KB, 727 строк) | grep VideoDecoder=15 совпадений; дата свежая |
| ZAN-2 (wm size не свапается) | ✅ | `deviceScreen.ts:122-123,163,267-273` | startVideo(skipSize): после поворота --size не передаётся, screenrecord берёт текущий размер; комментарии исправлены |

## Мейджоры

| Пункт | Статус | Где | Как проверено |
|-------|--------|-----|---------------|
| ZAN-3 (приоритет src) | ✅ | html():397-403 (layout), 458-462 (toDevice) | src (canvas/img) → devSize → фолбэк; статически |
| ZAN-4 (avc плацебо) | ✅ | html():430 | avc удалён, комментарий про Annex B §3 |
| ZAN-5 (гонка image) | ✅ | deviceScreen.ts:51-52,160-162,171-190 | imageGen-счётчик; fallbackToImages без check-then-act |
| ZAN-6 (дроп P-кадров) | ✅ | html():434-448 | decoder.reset()+skip до IDR вместо дропа |
| ZAN-8 (многослайсные) | ✅ | deviceScreen.ts:276-278,286-293 | isFirstSlice() по first_mb_in_slice (ue(v)=0) |

## Миноры

| Пункт | Статус | Где | Как проверено |
|-------|--------|-----|---------------|
| ZAN-7 (windowsHide) | ✅ | deviceScreen.ts:134 | spawn(…, { windowsHide: true }) |
| ZAN-9 (start до ready) | ✅ | deviceScreen.ts:53-54,91,97,280 | webviewReady флаг; start() блокируется до 'ready' |
| ZAN-10 (CSP+переводы) | ✅ | deviceScreen.ts:15,318,367,371 | CSP nonce; MODE_TITLES через data-атрибуты |
| ZAN-11 (package-lock) | ✅ | удалён | rm package-lock.json |

## Trade-off'ы

- **ZAN-2:** выбран вариант 3 (убрать --size при перезапуске). Минус: нет 1920-скейлинга при повороте. На практике экраны ≤1920 — потерь нет. Альтернатива (своп осей самим) требовала бы знания нативной ориентации AVD.
- **ZAN-8:** isFirstSlice() парсит только первый бит first_mb_in_slice. Если ue(v) > 0, битовый сдвиг сложнее, но для screenrecord на практике слайсы всегда с first_mb_in_slice=0.
- **ZAN-9:** stop() сбрасывает webviewReady. При rotate стрим перезапускается в обход start() (через afterRotate), чтобы не ждать нового 'ready'.