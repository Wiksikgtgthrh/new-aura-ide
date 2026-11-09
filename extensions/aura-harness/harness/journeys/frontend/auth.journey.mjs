// journeys/frontend/auth.journey.mjs
// Auth journey: login → глаз пароля → невалидный email → короткий пароль → register+consent →
// login → refresh (сессия живая) → logout → refresh (аноним). Демо-auth не должен ходить в сеть.
import { visible, hidden, textMatches, storageWithinContract, watchExternalRequests } from '../lib/assert.mjs';
import { cleanStorage } from '../fixtures/storage.mjs';

export default {
  id: 'auth',
  title: 'Auth journey: валидация, регистрация, сессия, выход',
  preconditions: ['есть кнопка входа и auth-модалка', 'сессия хранится в localStorage по контракту'],
  completion: [
    'невалидный email и короткий пароль дают понятные ошибки до отправки',
    'регистрация требует consent',
    'после refresh сессия сохраняется; после logout и refresh — аноним',
    'демо-auth не шлёт внешних запросов',
    'storage не выходит за пределы контракта',
  ],
  fixtures: { seed: 42, cleanStorage: true },

  steps: (cfg) => {
    const s = {
      openBtn: '#btn-login',
      modal: '#auth-modal',
      switchBtn: '#auth-switch-btn',
      error: '#auth-error',
      submit: '#auth-submit',
      loginEmail: '#login-email',
      loginPassword: '#login-password',
      eye: '[data-eye="login-password"]',
      regName: '#reg-name',
      regEmail: '#reg-email',
      regPassword: '#reg-password',
      regConfirm: '#reg-confirm',
      consent: '#reg-consent',
      userChip: '#user-chip',
      logout: '[data-logout]',
      ...cfg.selectors?.auth,
    };
    const user = cfg.authUser ?? { name: 'Тестовый Пилот', email: 'pilot@test.dev', password: 'journey-2026' };
    return [
      {
        name: 'открыть модалку входа',
        screenshot: 'login-open',
        a11y: true,
        run: async (page) => {
          await page.locator(s.openBtn).click();
          await visible(page, s.modal, 'auth-модалка');
        },
      },
      {
        name: 'глаз показывает пароль',
        run: async (page) => {
          await page.locator(s.loginPassword).fill('secret-123');
          await page.locator(s.eye).click();
          const type = await page.locator(s.loginPassword).getAttribute('type');
          if (type !== 'text') {throw new Error(`пароль не раскрылся, type=${type}`);}
          await page.locator(s.eye).click();
        },
      },
      {
        name: 'невалидный email → ошибка',
        run: async (page) => {
          await page.locator(s.loginEmail).fill('не-email');
          await page.locator(s.submit).click();
          await textMatches(page, s.error, /email/i, 'ошибка email');
        },
      },
      {
        name: 'короткий пароль → ошибка',
        run: async (page) => {
          await page.locator(s.loginEmail).fill(user.email);
          await page.locator(s.loginPassword).fill('123');
          await page.locator(s.submit).click();
          await textMatches(page, s.error, /8|символ/i, 'ошибка длины пароля');
        },
      },
      {
        name: 'регистрация без consent → ошибка',
        run: async (page) => {
          await page.locator(s.switchBtn).click();
          await page.locator(s.regName).fill(user.name);
          await page.locator(s.regEmail).fill(user.email);
          await page.locator(s.regPassword).fill(user.password);
          await page.locator(s.regConfirm).fill(user.password);
          await page.locator(s.submit).click();
          await textMatches(page, s.error, /соглас/i, 'ошибка consent');
        },
      },
      {
        name: 'регистрация с consent → сессия, без внешних запросов',
        screenshot: 'registered',
        run: async (page) => {
          const watch = watchExternalRequests(page);
          await page.locator(s.consent).check();
          await page.locator(s.submit).click();
          await page.waitForTimeout(1000);
          await hidden(page, s.modal, 'модалка после регистрации');
          await visible(page, s.userChip, 'user chip');
          watch.assertNone('регистрация');
        },
      },
      {
        name: 'refresh → сессия живая; storage в контракте',
        run: async (page, ctx) => {
          await page.reload({ waitUntil: 'networkidle' });
          await visible(page, s.userChip, 'user chip после refresh');
          const allowed = ctx.config.storageContract?.allowed ?? [];
          await storageWithinContract(page, allowed);
        },
      },
      {
        name: 'logout → refresh → аноним',
        run: async (page) => {
          await page.locator(s.logout).click();
          await page.reload({ waitUntil: 'networkidle' });
          await visible(page, s.openBtn, 'кнопка входа');
          await hidden(page, s.userChip, 'user chip после logout');
        },
      },
    ];
  },
};
