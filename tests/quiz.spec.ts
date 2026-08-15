import { test, expect } from '@playwright/test';
import { CharlieQuizPage } from '../src/pages/CharlieQuizPage';
import { generateTestEmail, generateTestPhone } from '../src/utils/testData';
import { waitForUserAndBooking } from '../src/utils/backendClient';

const QUIZ_START_URL = '/uk/app/sign-up/long/charlie/age-range';

test.describe('Charlie реєстраційний квіз — стійкий до A/B прохід', () => {
  test('користувач доходить до кінця квіза, юзер створюється і урок бронюється', async ({ page }) => {
    const quiz = new CharlieQuizPage(page);

    const testEmail = generateTestEmail();
    const testPhone = generateTestPhone();

    await quiz.open(QUIZ_START_URL);

    // Проходимо квіз із передачею чітко зафіксованих даних
    await quiz.runToCompletion({ email: testEmail, phone: testPhone });
    await quiz.assertNotBroken();

    // --- Детермінована частина: перевіряємо бізнес-результат, а не UI ---

    // 1. Перевірка аналітики
    const analyticsHits = quiz.getAnalyticsHits();
    expect(
      analyticsHits.length,
      'Жодного аналітичного івенту не було відправлено за весь прохід квіза',
    ).toBeGreaterThan(0);

    // 2. Перевірка мережевого виклику
    expect(
      quiz.wasBookingRequestSent(),
      'Не зафіксовано мережевого виклику до ендпоінту бронювання пробного уроку',
    ).toBe(true);

    // 3. Перевірка створення юзера та бронювання на бекенді
    const { user, booking } = await waitForUserAndBooking(testEmail);
    expect(user.exists, 'Юзер не знайдений в бекенді після завершення квіза').toBe(true);
    expect(booking.exists, 'Бронювання пробного уроку не знайдено після завершення квіза').toBe(true);
  });
});
