import { expect, test } from '@playwright/test'
import { openRoute } from './helpers'
import { routes } from './routes'

// Baselines are OS/browser specific. Create and update them only on the same platform
// as CI (or in the Playwright Docker image), and only with human approval.
for (const route of routes.filter((r) => !r.skipVisual)) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`${route.name} matches baseline (${colorScheme}) @visual`, async ({ page }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await openRoute(page, route)
      await expect(page).toHaveScreenshot(`${route.name}-${colorScheme}.png`, {
        fullPage: true,
        mask: [page.locator('[data-visual-mask]')],
      })
    })
  }
}
