import { expect, test } from '@playwright/test'
import { collectConsoleErrors, horizontalOverflow, openRoute } from './helpers'
import { routes } from './routes'

for (const route of routes) {
  test(`${route.name} renders without errors @e2e`, async ({ page }) => {
    const errors = collectConsoleErrors(page)
    const response = await openRoute(page, route)

    expect(response?.status() ?? 0, 'HTTP status').toBeLessThan(400)
    await expect(page.locator('main'), 'page has a <main> landmark').toHaveCount(1)
    await expect(page.locator('h1'), 'page has exactly one <h1>').toHaveCount(1)
    expect(await horizontalOverflow(page), 'no horizontal scroll').toBeLessThanOrEqual(0)
    expect(errors, 'console errors').toEqual([])
  })

  test(`${route.name} images load and have alt @e2e`, async ({ page }) => {
    await openRoute(page, route)
    const broken = await page.locator('img').evaluateAll((imgs) =>
      (imgs as HTMLImageElement[]).filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.currentSrc || img.src),
    )
    expect(broken, 'broken images').toEqual([])
    const missingAlt = await page.locator('img:not([alt])').count()
    expect(missingAlt, 'images without alt attribute').toBe(0)
  })
}
