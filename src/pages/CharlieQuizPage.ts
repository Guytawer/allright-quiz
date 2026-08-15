import { Page, Request } from '@playwright/test';
import { QuizBrokenError, RunnerLostError } from '../utils/errors';
import { generateTestEmail, generateTestPhone, TEST_FIRST_NAME, TEST_LAST_NAME } from '../utils/testData';

const MAX_STEPS = 15;
const STEP_TIMEOUT_MS = 8_000;

const COMPLETION_URL_PATTERNS = [/\/success/i, /\/booking-confirmed/i, /\/sign-up\/complete/i];
const COMPLETION_DOM_MARKERS = ['[data-testid="quiz-complete"]', '[data-testid="booking-confirmed"]'];
const BOOKING_ENDPOINT_PATTERN = /\/api\/.*\/(trial-booking|book-trial)/i;

export interface AnalyticsHit {
  url: string;
  postData: string | null;
}

export interface QuizUserData {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
}

export class CharlieQuizPage {
  private analyticsHits: AnalyticsHit[] = [];
  private bookingRequestSeen = false;
  private userData: QuizUserData = {};

  constructor(private readonly page: Page) {
    this.attachNetworkListeners();
  }

  private attachNetworkListeners() {
    this.page.on('request', (request: Request) => {
      const url = request.url();

      if (/gtm|google-analytics|analytics\.js|amplitude/i.test(url)) {
        this.analyticsHits.push({ url, postData: request.postData() });
      }

      if (BOOKING_ENDPOINT_PATTERN.test(url)) {
        this.bookingRequestSeen = true;
      }
    });
  }

  async open(startUrl: string) {
    await this.page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  }

  /**
   * Основний цикл: підтримує передачу зафіксованого контексту користувача (email/phone),
   * щоб заповнювати сторінку саме тими даними, які потім перевіряє бекенд.
   */
  async runToCompletion(userData?: QuizUserData): Promise<void> {
    if (userData) {
      this.userData = userData;
    }

    for (let step = 0; step < MAX_STEPS; step++) {
      if (await this.isComplete()) {
        return;
      }

      const acted = await this.handleCurrentScreen();
      if (!acted) {
        const screenshotPath = `test-results/unrecognized-screen-step-${step}.png`;
        await this.page.screenshot({ path: screenshotPath }).catch(() => {});
        throw new RunnerLostError(
          `Раннер не впізнав екран на кроці ${step}. Ймовірно, з'явився новий A/B-варіант ` +
            `або новий тип поля — раннер потребує оновлення евристик, а не обов'язково є багом квіза.`,
          step,
        );
      }

      await this.page.waitForTimeout(400); // даємо UI застабілізуватись між кроками
    }

    if (!(await this.isComplete())) {
      throw new RunnerLostError(
        `Не вдалося дійти до завершення квіза за ${MAX_STEPS} кроків.`,
        MAX_STEPS,
      );
    }
  }

  async isComplete(): Promise<boolean> {
    const url = this.page.url();
    if (COMPLETION_URL_PATTERNS.some((pattern) => pattern.test(url))) {
      return true;
    }

    for (const marker of COMPLETION_DOM_MARKERS) {
      if (await this.page.locator(marker).count()) {
        return true;
      }
    }

    return this.bookingRequestSeen;
  }

  private async handleCurrentScreen(): Promise<boolean> {
    if (await this.tryFillTextInputs()) return true;
    if (await this.trySelectSingleChoice()) return true;
    if (await this.tryClickPrimaryAction()) return true;
    return false;
  }

  private async tryFillTextInputs(): Promise<boolean> {
    const inputs = this.page.locator('input:visible:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])');
    const count = await inputs.count();
    if (count === 0) return false;

    let filledAny = false;

    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      const value = await input.inputValue().catch(() => '');
      if (value) continue;

      const type = (await input.getAttribute('type')) ?? '';
      const name = ((await input.getAttribute('name')) ?? '').toLowerCase();
      const autocomplete = ((await input.getAttribute('autocomplete')) ?? '').toLowerCase();
      const signature = `${type} ${name} ${autocomplete}`;

      let fillValue: string | null = null;
      if (type === 'email' || signature.includes('email')) {
        fillValue = this.userData.email ?? generateTestEmail();
      } else if (type === 'tel' || signature.includes('phone')) {
        fillValue = this.userData.phone ?? generateTestPhone();
      } else if (signature.includes('first') && signature.includes('name')) {
        fillValue = this.userData.firstName ?? TEST_FIRST_NAME;
      } else if (signature.includes('last') && signature.includes('name')) {
        fillValue = this.userData.lastName ?? TEST_LAST_NAME;
      } else if (signature.includes('name')) {
        fillValue = `${this.userData.firstName ?? TEST_FIRST_NAME} ${this.userData.lastName ?? TEST_LAST_NAME}`;
      } else if (type === 'text' || type === '') {
        fillValue = 'Automated QA response';
      }

      if (fillValue !== null) {
        await input.fill(fillValue, { timeout: STEP_TIMEOUT_MS }).catch(() => null);
        filledAny = true;
      }
    }

    return filledAny;
  }

  private async trySelectSingleChoice(): Promise<boolean> {
    const radios = this.page.locator('input[type="radio"]:visible, input[type="checkbox"]:visible');
    if (await radios.count()) {
      await radios.first().check({ timeout: STEP_TIMEOUT_MS }).catch(() => null);
      return true;
    }

    const cardOptions = this.page.locator(
      '[data-testid*="option"]:visible, [role="button"][class*="option"]:visible, button[class*="answer"]:visible',
    );
    if (await cardOptions.count()) {
      await cardOptions.first().click({ timeout: STEP_TIMEOUT_MS }).catch(() => null);
      return true;
    }

    return false;
  }

  private async tryClickPrimaryAction(): Promise<boolean> {
    const candidates = [
      this.page.getByRole('button', { name: /далі|continue|next|продовжити|почати/i }),
      this.page.locator('button[type="submit"]:visible'),
      this.page.locator('[data-testid*="next"]:visible, [data-testid*="continue"]:visible'),
    ];

    for (const candidate of candidates) {
      if (await candidate.count()) {
        const button = candidate.first();

        // Очікуємо можливої мікро-анімації активації кнопки
        const isEnabled = await button.isEnabled().catch(() => false);
        if (!isEnabled) {
          await this.page.waitForTimeout(500);
        }

        if (await button.isEnabled().catch(() => false)) {
          await button.click({ timeout: STEP_TIMEOUT_MS }).catch(() => null);
          return true;
        }
      }
    }

    return false;
  }

  async assertNotBroken(): Promise<void> {
    const hasErrorBanner = await this.page
      .locator('[data-testid*="error"]:visible, [role="alert"]:visible')
      .count();
    if (hasErrorBanner) {
      const screenshotPath = 'test-results/quiz-broken.png';
      await this.page.screenshot({ path: screenshotPath }).catch(() => {});
      throw new QuizBrokenError('На екрані з\'явився блок помилки — квіз, ймовірно, реально зламаний.', screenshotPath);
    }
  }

  getAnalyticsHits(): AnalyticsHit[] {
    return this.analyticsHits;
  }

  wasBookingRequestSent(): boolean {
    return this.bookingRequestSeen;
  }
}
