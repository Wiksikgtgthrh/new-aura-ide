---
name: web-motion
description: >-
  Плавные анимации интерфейса: easing и springs, transform/opacity-only,
  stagger, layout/FLIP-анимации, scroll-driven, Framer Motion и CSS,
  60 fps без jank. Включать, когда задача про анимации, переходы, «сделай
  плавно», motion, появление блоков, hover-эффекты, параллакс, page transitions,
  framer-motion, gsap, spring, микровзаимодействия в UI.
---

# Web Motion — плавные анимации

Анимация — это физика и ритм, а не «добавь transition: all». Jank недопустим.

## Железные правила производительности

- Анимируй ТОЛЬКО `transform` и `opacity`. Всё остальное (width, height, top,
  left, margin) вызывает layout — слайд-шоу вместо анимации.
- `will-change` — точечно и временно, не развешивай на всё подряд.
- 60 fps = 16 мс на кадр. Тяжёлое в кадре (фильтры, тени-простыни, backdrop-blur
  на больших площадях) — первый подозреваемый при jank.
- `prefers-reduced-motion` — обязателен: отключай/упрощай, не игнорируй.

## Кривые: easing vs spring

- **CSS easing** для простого: стандарт «выезд» — `cubic-bezier(0.16, 1, 0.3, 1)`
  (easeOutExpo-подобная), длительность 200–400 мс для UI, до 700 мс для hero.
- **Springs** (пружины) для физичного ощущения: framer-motion `transition:
  { type: "spring", stiffness, damping }`. Пружина живее любой кривой — но не
  ставь пружину на всё: подпрыгивающая форма оплаты выглядит дешево.
- Никогда не `linear` для UI и не `transition: all` — перечисляй свойства явно.

## Рецепты, которые «жёстко бустят»

- **Stagger** (каскад): список появляется по одному элементу с задержкой
  30–60 мс — сразу «дорого».
- **Layout/FLIP**: элемент плавно переезжает при изменении раскладки —
  `layout` в framer-motion, `View Transitions API` для смены страниц.
- **Scroll-driven**: reveal по IntersectionObserver один раз (не при каждом
  скролле), параллакс — только через `transform: translate3d`.
- **Hover**: scale(1.02) + тень за 150–250 мс — достаточно. Не scale(1.2).
- **Page transitions**: View Transitions API там, где поддерживается; фолбэк —
  fade.

## Инструменты по стеку

- React → **framer-motion** (motion/react): `initial/animate/exit`, `layout`,
  `AnimatePresence` для unmount-анимаций.
- Без React → CSS transitions/keyframes + Web Animations API; GSAP — если нужны
  таймлайны и scrub по скроллу.
- Физика столкновений/тел в 2D/3D → Rapier (см. threejs-stack для 3D-сцен).

## Антипаттерны

- Анимация на каждом блоке подряд — шум, а не дизайн. Один акцент на экран.
- Бесконечные анимации (пульс, покачивание) на контенте — отвлекают от чтения.
- Анимации, блокирующие ввод: пользователь кликает раньше, чем доехало.

## Проверка

- DevTools → Performance: запись взаимодействия, нет dropped frames.
- Проверить на слабом: CPU throttle 4x — всё ещё плавно?
