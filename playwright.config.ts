import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    // Страхувальна сітка: жодна дія не має права чекати вічно.
    actionTimeout: 10_000,
    baseURL: process.env.QUIZ_BASE_URL ?? 'https://stage.allright.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Квіз програє відео-ролики персонажа (без muted) і, схоже,
        // переходить на наступний крок по події 'ended'. У звичайному
        // Chrome autoplay без взаємодії користувача блокується — у
        // headless-Playwright реальної взаємодії немає, тому play()
        // відхиляється і застосунок показує "Помилка завантаження".
        // Прапорець нижче знімає цю autoplay-політику саме для тестів.
        launchOptions: {
          args: ['--autoplay-policy=no-user-gesture-required'],
        },
      },
    },
  ],
});
