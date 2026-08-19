import { Action, SolveContext, Solver, StepSnapshot } from '../types';
import { renderSnapshot } from '../snapshot';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

/**
 * LLM-солвер.
 *
 * Навіщо він тут, якщо евристика вже проходить квіз: евристика бачить елементи,
 * але не розуміє сенсу. На кроці з попапом «хто заповнює анкету» вона вперлась,
 * бо для неї це просто ще один набір кліків. Модель читає «Я — мати або батько»
 * і розуміє, що для бронювання пробного дитині потрібен саме цей варіант.
 *
 * Модель вирішує ТІЛЬКИ як пройти далі. Вердикт «пройшло чи ні» виносить
 * детермінована перевірка результату — інакше система оцінювала б сама себе.
 */
export class LlmSolver implements Solver {
  readonly name = 'llm';

  /** Груба статистика витрат — щоб було що написати про вартість прогону. */
  public usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

  constructor(private readonly apiKey = process.env.ANTHROPIC_API_KEY) {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY не заданий');
  }

  async decide(step: StepSnapshot, ctx: SolveContext): Promise<Action[]> {
    const prompt = buildPrompt(step, ctx);

    // Без таймауту один зависаний виклик з'їдає весь бюджет тесту.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);

    const res = await fetch(API_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const data: any = await res.json();
    this.usage.calls++;
    this.usage.inputTokens += data.usage?.input_tokens ?? 0;
    this.usage.outputTokens += data.usage?.output_tokens ?? 0;

    const text = (data.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');

    return parseActions(text, step);
  }
}

const SYSTEM = `Ти керуєш браузером, який проходить квіз реєстрації на платформі
онлайн-навчання англійської для дітей.

МЕТА: зареєструватись як БАТЬКО або МАТИ і забронювати БЕЗКОШТОВНИЙ ПРОБНИЙ УРОК
для своєї дитини. На цьому мета закінчується.

Якщо на екрані є вибір, хто заповнює анкету, — обирай варіант батька, а не дитини.

ЧОГО РОБИТИ НЕ МОЖНА (це важливіше за досягнення мети):
- Не купувати підписку, пакети занять, тарифні плани.
- Не переходити до оплати, не обирати спосіб оплати, не вводити дані картки.
- Не тиснути кнопки на кшталт "Оплатити", "Перший місяць безкоштовно",
  "Обрати тариф", "Плати частинами" — навіть якщо вони виглядають як
  продовження реєстрації.
- Не вводити промокоди.
Якщо єдиний доступний шлях веде до оплати — це НЕ той шлях. Поверни "stuck"
і поясни, що бачиш тільки платіжні дії.

Після успішної реєстрації шукай саме бронювання пробного уроку: вибір часу,
розкладу, викладача, кнопки на кшталт "Записатись на пробний", "Обрати час".
Якщо бачиш, що урок уже заброньований або з'явилось підтвердження — поверни "done".

Тобі дають список інтерактивних елементів поточного екрана з числовими id.
Ти відповідаєш, які дії виконати.

Відповідай ТІЛЬКИ валідним JSON, без пояснень і без markdown-огорожі:
{"actions":[{"kind":"click","targetId":3,"reason":"коротко чому"}]}

Дозволені kind: "click", "fill" (тоді потрібне поле "value"), "done", "stuck".
Можна повернути кілька дій — наприклад заповнити поле і натиснути "далі".
Але якщо вибір одиночний (після кліку екран одразу змінюється), давай ОДНУ дію:
зайві кліки полетять у вже неіснуючі елементи.

Якщо не бачиш, що робити, поверни {"actions":[{"kind":"stuck","reason":"..."}]}.

Важливо: якщо на екрані попап або модальне вікно, спершу розберись із ним —
елементи під ним перекриті й натиснути їх неможливо.

У полі reason пиши те, що справді бачиш на екрані, а не те, що очікуєш побачити
за метою. Ці пояснення читає людина при розборі падінь.`;

function buildPrompt(step: StepSnapshot, ctx: SolveContext): string {
  const parts = [renderSnapshot(step)];

  if (step.errors.length) {
    parts.push(`\nПомилки на екрані: ${step.errors.join(' / ')}`);
  }

  parts.push(
    `\nДані для заповнення полів:
- ім'я батька/матері: ${ctx.identity.parentName}
- ім'я дитини: ${ctx.identity.childName}
- вік дитини: ${ctx.identity.childAge}
- email: ${ctx.identity.email}
- телефон: ${ctx.identity.phone}`,
  );

  if (ctx.attempt > 0) {
    parts.push(
      `\nУВАГА: це спроба ${ctx.attempt + 1} на цьому ж екрані. Попередні дії не дали
переходу далі, тому НЕ повторюй їх. Що вже пробували:
${ctx.triedOnThisStep.map((t) => `- ${t}`).join('\n')}

Подумай, що ще на екрані могло залишитись поза увагою — можливо, з'явився попап
або якийсь елемент треба вибрати перед тим, як тиснути «далі».`,
    );
  }

  return parts.join('\n');
}

/** Парсинг і валідація відповіді. Все підозріле — виняток, далі спрацює фолбек. */
function parseActions(text: string, step: StepSnapshot): Action[] {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`не JSON: ${cleaned.slice(0, 120)}`);

  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  const raw = parsed.actions;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('порожній actions');

  const ids = new Set(step.elements.map((e) => e.id));
  const actions: Action[] = [];

  for (const a of raw.slice(0, 4)) {
    if (a.kind === 'stuck') return [{ kind: 'stuck', reason: String(a.reason ?? '') }];
    if (a.kind === 'done') return [{ kind: 'done', reason: String(a.reason ?? '') }];

    // Модель могла вигадати id — на такий випадок краще впасти у фолбек,
    // ніж клікнути навмання по чужому елементу.
    if (!ids.has(a.targetId)) throw new Error(`неіснуючий targetId=${a.targetId}`);

    if (a.kind === 'click') {
      actions.push({ kind: 'click', targetId: a.targetId, reason: String(a.reason ?? 'llm') });
    } else if (a.kind === 'fill') {
      if (typeof a.value !== 'string' || !a.value) throw new Error('fill без value');
      actions.push({
        kind: 'fill',
        targetId: a.targetId,
        value: a.value,
        reason: String(a.reason ?? 'llm'),
      });
    } else {
      throw new Error(`невідомий kind=${a.kind}`);
    }
  }

  return actions;
}
