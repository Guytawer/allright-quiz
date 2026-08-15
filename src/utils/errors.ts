/**
 * Свідомо розділяємо два різні failure-стани, бо для команди це різні за змістом
 * сигнали і їх не можна валити в один алерт:
 *
 *  - QuizBrokenError   -> продукт реально зламаний (немає interactive-елементів,
 *                         помилка на сторінці, застряг на конкретному кроці)
 *  - RunnerLostError   -> раннер не впізнав екран за відведену кількість кроків.
 *                         Це НЕ обов'язково баг квіза — швидше сигнал "з'явився
 *                         новий A/B-варіант, раннер потребує оновлення евристик".
 */

export class QuizBrokenError extends Error {
  constructor(message: string, public readonly screenshotPath?: string) {
    super(message);
    this.name = 'QuizBrokenError';
  }
}

export class RunnerLostError extends Error {
  constructor(message: string, public readonly stepsTaken: number) {
    super(message);
    this.name = 'RunnerLostError';
  }
}
