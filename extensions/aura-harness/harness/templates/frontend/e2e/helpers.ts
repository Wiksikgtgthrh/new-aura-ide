import type { Page } from '@playwright/test'
import type { RouteCheck } from './routes'

export async function openRoute(page: Page, route: RouteCheck) {
  const response = await page.goto(route.path, { waitUntil: 'networkidle' })
  if (route.waitFor) await page.locator(route.waitFor).first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  return response
}

export function collectConsoleErrors(page: Page) {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(err.message))
  return errors
}

export async function horizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}
