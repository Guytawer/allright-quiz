/**
 * Всі тестові юзери мають впізнавану сигнатуру:
 *  - домен allrighttest.com (окремо від живих юзерів)
 *  - timestamp у локал-парті, щоб гарантувати унікальність між прогонами
 *
 * Це дозволяє бекенду фільтрувати/чистити такі акаунти окремою джобою
 * і виключати їх з аналітики та CRM-воронок.
 */
export function generateTestEmail(): string {
  const ts = Date.now();
  return `qa_autotest_${ts}@allrighttest.com`;
}

export function generateTestPhone(): string {
  const suffix = String(Date.now()).slice(-7);
  return `+380${suffix}`;
}

export const TEST_FIRST_NAME = 'QA';
export const TEST_LAST_NAME = 'Automation';
