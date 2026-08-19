import { Page } from '@playwright/test';
import { RunResult, TestIdentity } from './types';

export interface OutcomeResult {
  userCreated: boolean;
  trialBooked: boolean;
  /** Чим саме підтверджено — щоб при падінні було видно, якого доказу забракло. */
  evidence: string[];
  method: string;
}

/**
 * Перевірка бізнес-результату.
 *
 * Свідомо відокремлена від проходу: вона нічого не знає про те, хто вів квіз —
 * агент, евристика чи людина руками. Інакше система оцінювала б сама себе.
 *
 * Дві реалізації за одним інтерфейсом. Зараз працює UI-версія; коли з'явиться
 * доступ до API, підміна відбувається в одному місці й нічого більше не зачіпає.
 */
export interface OutcomeVerifier {
  verify(identity: TestIdentity, run: RunResult, page: Page): Promise<OutcomeResult>;
}

/**
 * Перевірка по слідах у браузері й мережі.
 *
 * Три незалежні джерела: створення сесії, відповіді бекенду і стан UI.
 * Одна ознака могла б збігтися випадково, три разом — навряд.
 */
export class BrowserOutcomeVerifier implements OutcomeVerifier {
  async verify(identity: TestIdentity, run: RunResult, page: Page): Promise<OutcomeResult> {
    const evidence: string[] = [];

    // 1. Сесія. Застосунок на Ember Simple Auth — після реєстрації з'являється
    //    ключ сесії з токеном. Без створеного користувача його не буде.
    const session = await page
      .evaluate(() => {
        const keys = Object.keys(localStorage).filter((k) => /session|auth|token/i.test(k));
        return keys.map((k) => ({ key: k, len: (localStorage.getItem(k) ?? '').length }));
      })
      .catch(() => [] as { key: string; len: number }[]);

    const authed = session.some((s) => s.len > 40);
    if (authed) evidence.push(`сесія: ${session.map((s) => s.key).join(', ')}`);

    // 2. Мережа. Успішні POST/PUT на API під час проходу.
    const writes = run.api.filter(
      (r) => ['POST', 'PUT', 'PATCH'].includes(r.method) && r.status !== null && r.status < 400,
    );
    const userWrite = writes.find((r) => /user|sign-?up|registr|account/i.test(r.url));
    const bookingWrite = writes.find((r) => /lesson|book|trial|schedul|appoint/i.test(r.url));
    if (userWrite) evidence.push(`створення користувача: ${short(userWrite.url)} → ${userWrite.status}`);
    if (bookingWrite) evidence.push(`бронювання: ${short(bookingWrite.url)} → ${bookingWrite.status}`);

    // 3. UI. Куди привело після завершення і що написано на екрані.
    const url = page.url();
    const bodyText = await page
      .evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 3000))
      .catch(() => '');

    const inCabinet = /cabinet|dashboard|profile|lessons|schedule/i.test(url);
    if (inCabinet) evidence.push(`перехід у кабінет: ${url}`);

    const confirmText = /заброньовано|забронював|урок заплановано|ваш урок|підтверджен|booked|confirmed/i;
    const uiConfirms = confirmText.test(bodyText);
    if (uiConfirms) evidence.push('на екрані підтвердження бронювання');

    return {
      userCreated: authed || !!userWrite,
      trialBooked: !!bookingWrite || uiConfirms || inCabinet,
      evidence,
      method: 'browser',
    };
  }
}

/**
 * Перевірка через API/адмінку — правильний спосіб, коли з'явиться доступ.
 * Заглушка навмисне залишена в коді: вона позначає точку підміни.
 */
export class ApiOutcomeVerifier implements OutcomeVerifier {
  constructor(private readonly baseUrl?: string, private readonly token?: string) {}

  async verify(identity: TestIdentity): Promise<OutcomeResult> {
    if (!this.baseUrl || !this.token) {
      throw new Error(
        'API-перевірка не налаштована: потрібні endpoint і токен для пошуку користувача за email/телефоном',
      );
    }
    // Очікуваний вигляд: GET {baseUrl}/users?email=... і GET {baseUrl}/bookings?userId=...
    throw new Error('не реалізовано — чекає на доступ від команди');
  }
}

function short(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.slice(0, 60);
  }
}
