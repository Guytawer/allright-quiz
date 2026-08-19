/**
 * РОЗВІДКА: generic прохід по квізу реєстрації.
 *
 * Мета — відповісти на два питання:
 *   1. Чи проходить автоматизація капчу на кроці телефону.
 *   2. Чи справді патерн кроків однорідний настільно, що generic-солвер
 *      доїжджає до кінця без знання порядку кроків.
 *
 * ВАЖЛИВО: за дефолтом скрипт ЗУПИНЯЄТЬСЯ перед кроком телефону і НЕ робить
 * фінальний сабміт. Щоб дозволити — ALLOW_SUBMIT=1.
 *
 * Запуск:
 *   npx playwright test recon-quiz.spec.ts --headed
 *   ALLOW_SUBMIT=1 npx playwright test recon-quiz.spec.ts --headed   // створить реальні сутності!
 *   PIN_VARIANT=B npx playwright test recon-quiz.spec.ts             // запінити варіант
 */

import { test, Page } from '@playwright/test';
import * as fs from 'fs';

const ENTRY = 'https://stage.allright.com/uk/app/sign-up/long/charlie/age-range';

const ALLOW_SUBMIT = process.env.ALLOW_SUBMIT === '1';
const PIN_VARIANT = process.env.PIN_VARIANT; // undefined = йдемо тим варіантом, який видали
const MAX_STEPS = 40;

// Слаги, на яких зупиняємось (бо далі — побічні ефекти)
const STOP_SLUGS = ['user-info-phone'];
// Кнопки, які схожі на фінальний сабміт
const DANGER_BUTTON = /забронюва|заверш|підтверд|book|sign.?up|регістр|реєстр/i;
const NEXT_BUTTON = /продовжити|далі|продовжуємо|continue|next|поїхали|почати/i;

type Interactive = {
  reconId: number;
  tag: string;
  role: string | null;
  type: string | null;
  text: string;
  placeholder: string | null;
  disabled: boolean;
  isInput: boolean;
};

type StepRecord = {
  i: number;
  slug: string;
  url: string;
  heading: string;
  kind: string;
  action: string;
  progressed: boolean;
  candidates: number;
};

const steps: StepRecord[] = [];
const network: { method: string; url: string; status?: number; body?: string }[] = [];

/** Слаг кроку з URL — для логів, НЕ для логіки проходу. */
function slugOf(url: string): string {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * Згортання DOM: збираємо тільки інтерактивне й видиме, і мітимо
 * data-recon-id, щоб клікати без текстових локаторів.
 * Це ж саме згортання потім піде в промпт LLM-агенту.
 */
async function collectInteractive(page: Page): Promise<Interactive[]> {
  return await page.evaluate(() => {
    document.querySelectorAll('[data-recon-id]').forEach((e) => e.removeAttribute('data-recon-id'));

    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
    };

    const inChrome = (el: Element): boolean =>
      !!el.closest('header, footer, nav, [role="banner"], [role="navigation"]');

    const selector =
      'button, [role="button"], [role="radio"], [role="checkbox"], input, textarea, select, label, a[href]';
    const raw = new Set<Element>(Array.from(document.querySelectorAll(selector)));

    // Опції квіза можуть бути div'ами з обробником — ловимо по cursor: pointer
    for (const el of Array.from(document.querySelectorAll('div, li, span'))) {
      if (getComputedStyle(el).cursor === 'pointer' && el.children.length < 4) raw.add(el);
    }

    const out: any[] = [];
    let id = 0;
    for (const el of raw) {
      if (!visible(el) || inChrome(el)) continue;
      // не беремо контейнер, якщо всередині вже є відібраний нащадок
      if (Array.from(raw).some((other) => other !== el && el.contains(other) && visible(other))) continue;

      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const tag = el.tagName.toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (!text && !isInput) continue;

      el.setAttribute('data-recon-id', String(id));
      out.push({
        reconId: id,
        tag,
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        text,
        placeholder: el.getAttribute('placeholder'),
        disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
        isInput,
      });
      id++;
    }
    return out;
  });
}

async function headingOf(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const h = document.querySelector('h1, h2, [role="heading"]');
    return (h?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  });
}

/** Значення для інпута за евристикою типу. Патерн — щоб потім можна було відфільтрувати. */
function valueFor(el: Interactive, stamp: string): string {
  const hint = `${el.type ?? ''} ${el.placeholder ?? ''}`.toLowerCase();
  if (el.type === 'tel' || /phone|телефон/.test(hint)) return '0931112233';
  if (el.type === 'email' || /mail|пошт/.test(hint)) return `qa-recon-${stamp}@example.com`;
  if (el.type === 'number' || /вік|age/.test(hint)) return '8';
  // Поля імені зазвичай не приймають цифри й латиницю, і можуть мати мінімальну
  // довжину. Впізнаваний патерн лишається в email, де він потрібен для фільтрації.
  return 'Олена';
}

/** Класифікація кроку — без знання, який це саме крок. */
function classify(els: Interactive[]): string {
  if (els.some((e) => e.isInput)) return 'input';
  const next = els.filter((e) => NEXT_BUTTON.test(e.text));
  const options = els.filter((e) => !NEXT_BUTTON.test(e.text) && !DANGER_BUTTON.test(e.text));
  if (options.length === 0 && next.length > 0) return 'info';
  if (next.length > 0 && next.every((n) => n.disabled)) return 'multi-select';
  if (next.length > 0) return 'single-or-multi';
  return options.length > 0 ? 'single-select' : 'unknown';
}

test('recon: generic прохід по квізу', async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const stamp = String(Date.now());

  page.on('request', (r) => {
    const u = r.url();
    if (/\/api\/|jitsu/.test(u)) {
      network.push({ method: r.method(), url: u, body: (r.postData() ?? '').slice(0, 300) || undefined });
    }
  });
  page.on('response', async (r) => {
    if (/check-captcha|\/api\/v1\//.test(r.url())) {
      const rec = network.find((n) => n.url === r.url() && n.status === undefined);
      if (rec) rec.status = r.status();
    }
  });

  if (PIN_VARIANT) {
    // Пінінг — свідомо ОПЦІЯ для відтворення падінь, а не дефолт:
    // якщо завжди пінити один варіант, новий варіант ніколи не буде перевірений.
    await page.addInitScript((variant) => {
      localStorage.setItem(
        'experiments',
        JSON.stringify([{ alias: 'QUIZ_CHARLIE_VS_PERSONALIZED', variant }]),
      );
    }, PIN_VARIANT);
  }

  await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Який варіант нам видали — фіксуємо, бо за дефолтом ми його не пінимо
  const servedVariant = await page.evaluate(() => localStorage.getItem('experiments')).catch(() => null);
  console.log(`\nВхід: ${ENTRY}`);
  console.log(`Після редіректу: ${page.url()}`);
  console.log(`Варіант: ${servedVariant ?? '(не знайдено в localStorage)'}\n`);

  for (let i = 0; i < MAX_STEPS; i++) {
    await page.waitForTimeout(700);

    // попапи / кукі-банер — гасимо, якщо є
    for (const t of [/прийня|погодж|accept|зрозуміло|ok\b/i, /закри|close|×/i]) {
      const btn = page.getByRole('button', { name: t }).first();
      if (await btn.count().then((c) => c > 0).catch(() => false)) {
        await btn.click({ timeout: 1500 }).catch(() => {});
      }
    }

    const url = page.url();
    const slug = slugOf(url);
    const heading = await headingOf(page);
    let els = await collectInteractive(page);
    const kind = classify(els);

    // --- СТОП-УМОВИ (побічні ефекти) ---
    if (STOP_SLUGS.includes(slug) && !ALLOW_SUBMIT) {
      steps.push({ i, slug, url, heading, kind, action: 'STOP: стоп-слаг, сабміт заборонено', progressed: false, candidates: els.length });
      console.log(`[${i}] ${slug} — СТОП перед сабмітом (ALLOW_SUBMIT не заданий)`);
      break;
    }
    const danger = els.find((e) => DANGER_BUTTON.test(e.text) && !e.disabled);
    if (danger && !ALLOW_SUBMIT) {
      steps.push({ i, slug, url, heading, kind, action: `STOP: кнопка "${danger.text}"`, progressed: false, candidates: els.length });
      console.log(`[${i}] ${slug} — СТОП: схоже на фінальний сабміт ("${danger.text}")`);
      break;
    }

    // --- ДІЯ ---
    let action = 'нічого не знайшов';

    const inputs = els.filter((e) => e.isInput && !e.disabled);
    if (inputs.length > 0) {
      for (const inp of inputs) {
        const v = valueFor(inp, stamp);
        const loc = page.locator(`[data-recon-id="${inp.reconId}"]`);
        // fill() не завжди тригерить валідацію в Ember-формах — тому імітуємо
        // реальний ввід: клік, посимвольний набір, blur на виході з поля.
        await loc.click({ timeout: 2000 }).catch(() => {});
        await loc.fill('').catch(() => {});
        await loc.pressSequentially(v, { delay: 40 }).catch(() => {});
        await loc.blur().catch(() => {});
      }
      await page.waitForTimeout(400);
      action = `заповнив ${inputs.length} інпут(и)`;
      els = await collectInteractive(page); // кнопка «далі» могла активуватись
    }

    const options = els.filter(
      (e) => !e.isInput && !e.disabled && !NEXT_BUTTON.test(e.text) && !DANGER_BUTTON.test(e.text),
    );
    let next = els.find((e) => NEXT_BUTTON.test(e.text) && !e.disabled);
    const nextDisabled = els.find((e) => NEXT_BUTTON.test(e.text) && e.disabled);

    // мультиселект: «далі» неактивна → спершу вибираємо опцію
    if (inputs.length === 0 && options.length > 0 && (nextDisabled || !next)) {
      const pick = options[0];
      await page.locator(`[data-recon-id="${pick.reconId}"]`).click({ timeout: 3000 }).catch(() => {});
      action = `клік по опції "${pick.text.slice(0, 40)}"`;
      await page.waitForTimeout(500);
      els = await collectInteractive(page);
      next = els.find((e) => NEXT_BUTTON.test(e.text) && !e.disabled);
    }

    if (next) {
      await page.locator(`[data-recon-id="${next.reconId}"]`).click({ timeout: 3000 }).catch(() => {});
      action += ` + «${next.text.slice(0, 30)}»`;
    }

    // --- ЧИ БУВ ПРОГРЕС ---
    await page.waitForTimeout(1200);
    // Слаг унікальний на кожному кроці, тому це надійніше за заголовок
    // (на деяких кроках h1/h2 немає взагалі — тільки label).
    const progressed = slugOf(page.url()) !== slug || (await headingOf(page)) !== heading;

    steps.push({ i, slug, url, heading, kind, action, progressed, candidates: els.length });
    console.log(`[${i}] ${slug.padEnd(22)} ${kind.padEnd(16)} ${progressed ? '→' : '✗ застряг'}  ${action}`);

    if (!progressed) {
      console.log(`\nЗАСТРЯГ на "${slug}". Заголовок: "${heading}"`);
      console.log('Кандидати:', els.map((e) => `${e.tag}${e.disabled ? '[off]' : ''}:"${e.text.slice(0, 40)}"`).join(' | '));
      break;
    }
  }

  const captcha = network.filter((n) => /captcha/.test(n.url));
  const jitsu = network.filter((n) => /jitsu/.test(n.url));

  console.log(`\n— кроків пройдено: ${steps.length}`);
  console.log(`— captcha-запитів: ${captcha.length}${captcha.length ? ` (статуси: ${captcha.map((c) => c.status).join(', ')})` : ''}`);
  console.log(`— jitsu-подій: ${jitsu.length}`);
  console.log(`— тестовий патерн даних: qa-recon-${stamp}`);

  fs.writeFileSync(
    `recon-report-${stamp}.json`,
    JSON.stringify({ entry: ENTRY, finalUrl: page.url(), servedVariant, pinnedVariant: PIN_VARIANT ?? null, allowSubmit: ALLOW_SUBMIT, steps, network }, null, 2),
  );
  console.log(`\nЗвіт: recon-report-${stamp}.json`);
});