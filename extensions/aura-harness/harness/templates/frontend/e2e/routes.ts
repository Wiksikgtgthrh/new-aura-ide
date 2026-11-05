// Every user-facing route the agents must keep healthy. Add a route here in the same
// change that creates the page; e2e, a11y and visual specs all iterate this list.
export type RouteCheck = {
  path: string
  name: string
  waitFor?: string
  skipVisual?: boolean
}

export const routes: RouteCheck[] = [{ path: '/', name: 'home' }]
