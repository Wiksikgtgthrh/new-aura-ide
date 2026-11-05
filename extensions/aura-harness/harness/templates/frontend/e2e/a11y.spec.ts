import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { openRoute } from './helpers'
import { routes } from './routes'

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
// Framework dev overlays (Next.js, Vite) are not part of the product UI.
const DEV_OVERLAY = 'nextjs-portal, [data-nextjs-toast], [data-nextjs-dialog-overlay], vite-error-overlay'

for (const route of routes) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`${route.name} has no axe violations (${colorScheme}) @a11y`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme })
      await openRoute(page, route)
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).exclude('[data-a11y-ignore]').exclude('nextjs-portal').analyze()

      await testInfo.attach('axe-results', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' })
      const summary = results.violations.map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`)
      expect(summary, 'axe WCAG 2.2 AA violations').toEqual([])
    })
  }

  test(`${route.name} keyboard focus is visible @a11y`, async ({ page }) => {
    await openRoute(page, route)
    const focusables = await page
      .locator(`:is(${FOCUSABLE}):not(${DEV_OVERLAY}):not(${DEV_OVERLAY} *)`)
      .count()
    test.skip(focusables === 0, 'no focusable elements on this route')

    const steps = Math.min(focusables, 15)
    const invisible: string[] = []
    for (let i = 0; i < steps; i += 1) {
      await page.keyboard.press('Tab')
      const info = await page.evaluate((overlay) => {
        const el = document.activeElement as HTMLElement | null
        if (!el || el === document.body || el.closest(overlay)) return null
        const s = getComputedStyle(el)
        const visible = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'
        return { visible, label: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"` }
      }, DEV_OVERLAY)
      if (info && !info.visible) invisible.push(info.label)
    }
    expect(invisible, 'focused elements without a visible focus indicator').toEqual([])
  })

  test(`${route.name} respects prefers-reduced-motion @a11y`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openRoute(page, route)
    const longAnimations = await page.evaluate(() =>
      document.getAnimations().filter((a) => {
        const t = a.effect?.getComputedTiming()
        return t && (t.iterations === Infinity || Number(t.duration) > 500)
      }).length,
    )
    expect(longAnimations, 'long or infinite animations while reduced motion is requested').toBe(0)
  })
}
