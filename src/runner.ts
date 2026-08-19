import { Page } from '@playwright/test';
import { snapshot, slugOf } from './snapshot';
import { Action, Friction, RunResult, Solver, StepSnapshot, TestIdentity } from './types';

export interface RunOptions {
  entryUrl: string;
  identity: TestIdentity;
  solver: Solver;
  /** Фолбек, коли основний солвер здався або впав. */
  fallback?: Solver;
  /** Дозволити фінальний сабміт (створює реальні сутності). */
  allowSubmit: boolean;
  /** Запінити варіант — тільки для відтворення падінь, не для звичайних прогонів. */
  pinVariant?: string;
  maxSteps?: number;
  /** Скільки разів пробувати той самий крок, перш ніж визнати застрягання. */
  maxAttemptsPerStep?: number;
  log?: (line: string) => void;
}

/**
 * Стоп-умови перед побічними ефектами.
 *
 * Спиратись на слаги виявилось помилкою: у варіанті B крок телефону має слаг
 * user-info-phone, у варіанті A — інший, і агент проїхав повз запобіжник.
 * Тому основна ознака тепер змістова: поле телефону виглядає однаково в будь-якому
 * варіанті. Слаги лишились як додаткова, необов'язкова підказка.
 */
const STOP_SLUGS = ['user-info-phone'];
const SENSITIVE_FIELD = /телефон|phone|номер|e-?mail|пошт|картк|card/i;
const DANGER = /забронюва|заверш|підтверд|book|sign.?up|реєстр/i;

/**
 * Платіжні екрани — абсолютний стоп, незалежно від allowSubmit.
 *
 * У першому ж повному прогоні агент після реєстрації поїхав не до бронювання
 * пробного, а у флоу купівлі підписки, і дійшов до кнопки оплати. Врятувало
 * тільки те, що вона була неактивна. Дозволу на створення користувача
 * недостатньо, щоб дозволити платіж — це різні за наслідками дії.
 */
const PAYMENT = /оплатити|оплата|сплатити|до сплати|pay now|checkout|картк|card number|paypal|monobank|приватбанк|плати частинами/i;

function isPaymentScreen(step: { heading: string; elements: any[] }): string | null {
  if (PAYMENT.test(step.heading)) return `заголовок "${step.heading.slice(0, 50)}"`;
  const hit = step.elements.find((e) => PAYMENT.test(e.text) || PAYMENT.test(e.placeholder ?? ''));
  return hit ? `елемент "${(hit.text || hit.placeholder).slice(0, 50)}"` : null;
}

/** Чи зображений на екрані крок, після якого починаються побічні ефекти. */
function isSensitiveStep(step: { slug: string; heading: string; elements: any[] }): string | null {
  if (STOP_SLUGS.includes(step.slug)) return `слаг "${step.slug}"`;

  const telInput = step.elements.find(
    (e) => e.isInput && (e.type === 'tel' || SENSITIVE_FIELD.test(`${e.placeholder ?? ''}`)),
  );
  if (telInput) return `поле "${telInput.placeholder ?? telInput.type}"`;

  if (SENSITIVE_FIELD.test(step.heading) && step.elements.some((e) => e.isInput)) {
    return `екран "${step.heading.slice(0, 60)}"`;
  }
  return null;
}

/**
 * Прохід по квізу.
 *
 * Раннер не знає ні порядку кроків, ні їх кількості, ні текстів. Він уміє лише
 * зняти екран, спитати солвера що робити, зробити це і перевірити, чи змінився
 * екран. Тому новий A/B-варіант для нього нічим не відрізняється від старого.
 */
export async function runQuiz(page: Page, opts: RunOptions): Promise<RunResult> {
  const {
    entryUrl,
    identity,
    solver,
    fallback,
    allowSubmit,
    pinVariant,
    maxSteps = 40,
    maxAttemptsPerStep = 3,
    log = console.log,
  } = opts;

  const steps: RunResult['steps'] = [];
  const friction: Friction[] = [];
  const api: RunResult['api'] = [];

  // Мережа — найнадійніший доказ того, що бекенд справді щось створив.
  page.on('response', (r) => {
    const u = r.url();
    // Тільки API самого продукту: сторонні пікселі створюють сотні рядків шуму.
    if (/\/api\//.test(u) && /allright\.com/.test(u)) {
      api.push({ method: r.request().method(), url: u, status: r.status() });
    }
  });
  let stoppedBecause = 'вичерпано ліміт кроків';
  let reachedEnd = false;

  if (pinVariant) {
    // Пінінг свідомо не є дефолтом: якщо кожен прогін пінить відомий варіант,
    // щойно запущений варіант ніколи не буде перевірений — а це головний ризик.
    await page.addInitScript((v) => {
      localStorage.setItem(
        'experiments',
        JSON.stringify([{ alias: 'QUIZ_CHARLIE_VS_PERSONALIZED', variant: v }]),
      );
    }, pinVariant);
  }

  await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const servedVariant = await page
    .evaluate(() => localStorage.getItem('experiments'))
    .catch(() => null);
  log(`варіант: ${servedVariant ?? '(не визначено)'}`);
  log(`точка входу після редіректу: ${page.url()}`);

  let attempt = 0;
  let triedOnThisStep: string[] = [];
  // Запобіжник: відбиток екрана може дрібно змінюватись без реального переходу
  // (анімації, підвантаження). Рахуємо, скільки ітерацій поспіль сидимо на слагу.
  let sameSlugStreak = 0;

  for (let i = 0; i < maxSteps; i++) {
    await page.waitForTimeout(600);
    await dismissPopups(page);

    const step = await snapshot(page);

    // --- Стоп-умови: далі починаються побічні ефекти ---
    // Платіж зупиняє прогін завжди, навіть з allowSubmit.
    const payment = isPaymentScreen(step);
    if (payment) {
      stoppedBecause = `платіжний екран (${payment}) — прохід зупинено безумовно`;
      friction.push({ slug: step.slug, attempt, what: 'агент дійшов до екрана оплати замість бронювання пробного' });
      log(`[${i}] ${step.slug} — СТОП: платіжний екран (${payment})`);
      break;
    }

    const sensitive = isSensitiveStep(step);
    if (sensitive && !allowSubmit) {
      stoppedBecause = `чутливий крок (${sensitive}), сабміт не дозволено`;
      log(`[${i}] ${step.slug} — стоп перед сабмітом (${sensitive})`);
      break;
    }
    const dangerBtn = step.elements.find((e) => DANGER.test(e.text) && !e.disabled);
    if (dangerBtn && !allowSubmit) {
      stoppedBecause = `кнопка схожа на фінальний сабміт: "${dangerBtn.text}"`;
      log(`[${i}] ${step.slug} — стоп: "${dangerBtn.text}"`);
      break;
    }

    // Пишемо ДО рішення: якщо агент зависне всередині виклику моделі або на
    // кліку, у логах усе одно буде видно, на якому кроці це сталось.
    log(`[${i}] ${step.slug.padEnd(24)} → думаю... (${step.elements.length} елементів${step.inModal ? ', модалка' : ''})`);

    // --- Рішення ---
    let actions: Action[];
    let usedSolver = solver.name;
    try {
      actions = await solver.decide(step, { identity, attempt, triedOnThisStep });
      if (actions.length === 0 || actions[0].kind === 'stuck') throw new Error('солвер здався');
    } catch (err) {
      if (!fallback) {
        stoppedBecause = `солвер не впорався на "${step.slug}": ${String(err)}`;
        break;
      }
      const why = err instanceof Error ? err.message : String(err);
      friction.push({ slug: step.slug, attempt, what: `${solver.name} впав → фолбек: ${why}` });
      log(`      ↳ ${solver.name} не спрацював: ${why}`);
      actions = await fallback.decide(step, { identity, attempt, triedOnThisStep });
      usedSolver = fallback.name;
    }

    if (actions[0]?.kind === 'done') {
      reachedEnd = true;
      stoppedBecause = 'солвер вважає квіз завершеним';
      break;
    }

    // --- Виконання ---
    const performed = await applyActions(page, actions);
    triedOnThisStep.push(...performed);

    // --- Чи був прогрес ---
    await page.waitForTimeout(1200);
    const after = await snapshot(page);

    // Слага й заголовка недостатньо: частина кроків відкривається попапом поверх
    // того самого URL (наприклад, вибір «мати/батько» після вводу імені) — слаг
    // не змінюється, заголовка немає. Тому порівнюємо ще й склад екрана.
    const progressed =
      after.slug !== step.slug ||
      after.heading !== step.heading ||
      fingerprint(after) !== fingerprint(step);

    steps.push({ i, slug: step.slug, solver: usedSolver, actions: performed, progressed });
    const modalMark = step.inModal ? ' [модалка]' : '';
    log(`[${i}] ${step.slug.padEnd(24)} ${usedSolver.padEnd(10)} ${progressed ? '→' : '✗'}${modalMark} ${performed.join('; ')}`);

    sameSlugStreak = after.slug === step.slug ? sameSlugStreak + 1 : 0;
    if (sameSlugStreak >= 6) {
      stoppedBecause = `крутиться на "${step.slug}" ${sameSlugStreak} ітерацій без зміни кроку`;
      friction.push({ slug: step.slug, attempt, what: 'екран змінюється, але крок той самий' });
      log(`\nКРУТИТЬСЯ на "${step.slug}" — зупиняюсь`);
      break;
    }

    if (progressed) {
      attempt = 0;
      triedOnThisStep = [];
    } else {
      attempt++;
      // Тертя: агент застряг і пробує ще раз. Реальний користувач тут міг би піти.
      const errs = after.errors?.length ? ` | продукт каже: ${after.errors.join(' / ')}` : '';
      friction.push({
        slug: step.slug,
        attempt,
        what: `дія не дала прогресу: ${performed.join('; ')}${errs}`,
      });
      if (after.errors?.length) log(`      ↳ помилка на екрані: ${after.errors.join(' / ')}`);
      if (attempt >= maxAttemptsPerStep) {
        stoppedBecause = `застряг на "${step.slug}" після ${attempt} спроб`;
        log(`\nЗАСТРЯГ на "${step.slug}"`);
        log(step.elements.map((e) => `[${e.id}]${e.disabled ? '(off)' : ''} ${e.text || e.placeholder}`).join(' | '));
        if (after.errors?.length) log(`Повідомлення продукту: ${after.errors.join(' / ')}`);
        break;
      }
    }
  }

  return {
    servedVariant,
    entryUrl,
    finalUrl: page.url(),
    steps,
    friction,
    reachedEnd,
    stoppedBecause,
    api,
  };
}

/** Виконує дії по data-agent-id. Повертає людський опис того, що зробив. */
async function applyActions(page: Page, actions: Action[]): Promise<string[]> {
  const done: string[] = [];

  for (const a of actions) {
    if (a.kind === 'fill') {
      const loc = page.locator(`[data-agent-id="${a.targetId}"]`);
      // Таймаути обов'язкові на КОЖНІЙ дії: за замовчуванням Playwright чекає
      // придатності елемента без обмеження часу. Поле під модалкою придатним не
      // стане ніколи, і прохід зависає до таймауту всього тесту.
      // fill() не завжди тригерить валідацію в Ember — імітуємо реальний ввід.
      let ok = true;
      await loc.click({ timeout: 3000 }).catch(() => { ok = false; });
      await loc.fill('', { timeout: 3000 }).catch(() => { ok = false; });
      await loc.pressSequentially(a.value, { delay: 35, timeout: 8000 }).catch(() => { ok = false; });
      await loc.blur({ timeout: 2000 }).catch(() => {});
      done.push(`fill[${a.targetId}]="${a.value}"${ok ? '' : ' (не вдалось)'}`);
      await page.waitForTimeout(300);
    }

    if (a.kind === 'click') {
      const loc = page.locator(`[data-agent-id="${a.targetId}"]`);
      const ok = await loc
        .click({ timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      done.push(`click[${a.targetId}]${ok ? '' : ' (не вдалось)'} — ${a.reason}`);
      await page.waitForTimeout(400);
    }
  }

  return done;
}

/**
 * Відбиток екрана — набір елементів, які на ньому є.
 * Використовується тільки для детекції зміни екрана, не для логіки вибору дій.
 */
function fingerprint(s: StepSnapshot): string {
  return s.elements.map((e) => `${e.tag}:${e.text || e.placeholder || ''}`).join('|');
}

/**
 * Гасимо тільки кукі-банери й згоди.
 * Кнопки «закрити» свідомо не чіпаємо: частина кроків квіза приходить модалкою,
 * і закривши її, агент зламав би собі шлях.
 */
async function dismissPopups(page: Page): Promise<void> {
  for (const t of [/прийня|погодж|accept|зрозуміло/i]) {
    const btn = page.getByRole('button', { name: t }).first();
    const exists = await btn
      .count()
      .then((c) => c > 0)
      .catch(() => false);
    if (exists) await btn.click({ timeout: 1500 }).catch(() => {});
  }
}

export { slugOf };
