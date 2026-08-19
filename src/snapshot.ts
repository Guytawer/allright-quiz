import { Page } from '@playwright/test';
import { SnapshotElement, StepSnapshot } from './types';

/**
 * Згортання DOM.
 *
 * Навіщо окремим модулем: у LLM-солвері цей знімок іде в промпт, тому від його
 * компактності залежить і вартість прогону, і якість рішень. Сира сторінка в
 * контекст не влізе, а якщо влізе — модель потоне в розмітці.
 *
 * Кожному елементу проставляється data-agent-id, щоб клікати по ньому, а не по
 * тексту. Тексти в цьому квізі — найнестабільніше, що є (їх якраз і змінює A/B).
 */
export async function snapshot(page: Page): Promise<StepSnapshot> {
  const data = await page.evaluate(() => {
    document.querySelectorAll('[data-agent-id]').forEach((e) => e.removeAttribute('data-agent-id'));

    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
    };

    const inChrome = (el: Element): boolean =>
      !!el.closest('header, footer, nav, [role="banner"], [role="navigation"]');

    /**
     * Якщо на екрані модалка — знімаємо тільки її.
     * Модалка перехоплює взаємодію, а елементи під нею лишаються в DOM і
     * формально видимі. Без цього солвер намагається тиснути перекриті кнопки.
     *
     * Ознакою вважаємо не z-index (він часто на батьківському контейнері), а те,
     * що елемент реально перекриває решту: fixed-позиціювання в ланцюжку предків
     * плюс наявність затемненого тла на весь екран.
     */
    const findModal = (): Element | null => {
      const explicit = document.querySelector('[role="dialog"], [aria-modal="true"]');
      if (explicit && visible(explicit)) return explicit;

      // Чи є на екрані оверлей-підкладка (напівпрозоре тло на весь екран).
      const hasBackdrop = Array.from(document.querySelectorAll('div, section')).some((el) => {
        const st = getComputedStyle(el);
        if (st.position !== 'fixed') return false;
        const r = el.getBoundingClientRect();
        const full = r.width > window.innerWidth * 0.9 && r.height > window.innerHeight * 0.9;
        if (!full) return false;
        const bg = st.backgroundColor;
        return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
      });
      if (!hasBackdrop) return null;

      // Тло є — беремо те, що лежить зверху в центрі, і піднімаємось до
      // найближчого fixed/absolute контейнера з діями.
      const top = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      let node: Element | null = top;
      while (node && node !== document.body) {
        const st = getComputedStyle(node);
        const r = node.getBoundingClientRect();
        const coversScreen = r.width > window.innerWidth * 0.9 && r.height > window.innerHeight * 0.9;
        if (
          (st.position === 'fixed' || st.position === 'absolute') &&
          !coversScreen &&
          node.querySelectorAll('button, [role="button"], [class*="option" i]').length > 0
        ) {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    };

    const modal = findModal();
    const root: ParentNode = modal ?? document;

    const candidates = new Set<Element>(
      Array.from(
        root.querySelectorAll(
          'button, [role="button"], [role="radio"], [role="checkbox"], input, textarea, select, label, a[href]',
        ),
      ),
    );

    // Опції квіза часто не є <button> — це div з обробником. Ловимо по курсору.
    for (const el of Array.from(root.querySelectorAll('div, li, span'))) {
      if (getComputedStyle(el).cursor === 'pointer' && el.children.length < 4) candidates.add(el);
    }

    const elements: any[] = [];
    let id = 0;
    for (const el of candidates) {
      if (!visible(el) || inChrome(el)) continue;
      // Якщо всередині вже є відібраний нащадок — беремо нащадка, не контейнер.
      if (Array.from(candidates).some((o) => o !== el && el.contains(o) && visible(o))) continue;

      const tag = el.tagName.toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (!text && !isInput) continue;

      // Евристика «вибрано»: aria-checked, checked, або клас із selected/active/checked
      const cls = el.getAttribute('class') ?? '';
      const selected =
        el.getAttribute('aria-checked') === 'true' ||
        (el as HTMLInputElement).checked === true ||
        /selected|active|checked|chosen/i.test(cls);

      el.setAttribute('data-agent-id', String(id));
      elements.push({
        id,
        tag,
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        text,
        placeholder: el.getAttribute('placeholder'),
        disabled:
          (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
        isInput,
        selected,
      });
      id++;
    }

    // Повідомлення про помилки валідації — окремо від інтерактивних елементів.
    const errorSel =
      '[role="alert"], [aria-invalid="true"], [class*="error" i], [class*="invalid" i], [class*="warning" i]';
    const errors = Array.from(document.querySelectorAll(errorSel))
      .filter((e) => visible(e))
      .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 0 && t.length < 200)
      .slice(0, 5);

    const h = root.querySelector('h1, h2, [role="heading"]');
    // На частині кроків заголовка немає взагалі — тоді беремо перший label.
    const label = root.querySelector('label');
    const heading = (h?.textContent ?? label?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);

    return { heading, elements, errors, inModal: !!modal };
  });

  return {
    slug: slugOf(page.url()),
    url: page.url(),
    heading: data.heading,
    elements: data.elements as SnapshotElement[],
    errors: data.errors as string[],
    inModal: data.inModal as boolean,
  };
}

/** Слаг кроку з URL. Для логів і звітності — НЕ для логіки проходу. */
export function slugOf(url: string): string {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Текстове представлення знімка — для промпта LLM і для логів. */
export function renderSnapshot(s: StepSnapshot): string {
  const lines = s.elements.map((e) => {
    const flags = [
      e.disabled ? 'disabled' : null,
      e.selected ? 'selected' : null,
      e.isInput ? `input:${e.type ?? 'text'}` : null,
    ]
      .filter(Boolean)
      .join(',');
    const label = e.isInput ? e.placeholder ?? '' : e.text;
    return `[${e.id}] <${e.tag}${flags ? ' ' + flags : ''}> ${label}`;
  });
  return `Екран: ${s.heading || '(без заголовка)'}\n${lines.join('\n')}`;
}
