// Lighthouse CI measures the production build. Add every important route to ROUTES.
// Budgets may be tightened per project; loosening them needs a human decision.
const PORT = Number(process.env.LHCI_PORT ?? 3000)
const ROUTES = ['/']

module.exports = {
  ci: {
    collect: {
      startServerCommand: `__BUILD_CMD__PORT=${PORT} __SERVE_CMD__`,
      startServerReadyPattern: 'ready|started|listening|Local:',
      startServerReadyTimeout: 240000,
      url: ROUTES.map((route) => `http://localhost:${PORT}${route}`),
      numberOfRuns: 3,
      ...(process.env.CHROME_PATH ? { chromePath: process.env.CHROME_PATH } : {}),
      settings: {
        preset: 'desktop',
        chromeFlags: '--no-sandbox --headless=new',
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.9 }],
        'categories:accessibility': ['error', { minScore: 0.95 }],
        'categories:best-practices': ['error', { minScore: 0.9 }],
        'categories:seo': ['warn', { minScore: 0.9 }],
        'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
        'total-blocking-time': ['error', { maxNumericValue: 200 }],
        interactive: ['warn', { maxNumericValue: 3800 }],
        'total-byte-weight': ['warn', { maxNumericValue: 1600000 }],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: './.agent-state/artifacts/lhci',
    },
  },
}
