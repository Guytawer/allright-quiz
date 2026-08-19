import { Action, SolveContext, Solver, SnapshotElement, StepSnapshot } from '../types';

const NEXT = /продовжити|далі|продовжуємо|continue|next|поїхали|почати/i;
const DANGER = /забронюва|заверш|підтверд|book|sign.?up|реєстр/i;
/** Дії, які виглядають як опції, але ведуть убік від основного шляху. */
const SIDE = /код друга|promo|промокод|назад|back|пропустити|skip/i;

/**
 * Евристичний солвер.
 *
 * Робить дві роботи:
 *  1. Фолбек, коли LLM недоступний, віддав сміття або вичерпав ліміт.
 *  2. Базова лінія: якщо евристика проходить квіз не гірше за модель,
 *     то LLM у цьому місці не потрібен — і це чесний результат, а не поразка.
 */
export class HeuristicSolver implements Solver {
  readonly name = 'heuristic';

  async decide(step: StepSnapshot, ctx: SolveContext): Promise<Action[]> {
    const usable = step.elements.filter((e) => !e.disabled && !SIDE.test(e.text));
    const inputs = usable.filter((e) => e.isInput);
    const nextBtn = usable.find((e) => NEXT.test(e.text));
    const options = usable.filter(
      (e) => !e.isInput && !NEXT.test(e.text) && !DANGER.test(e.text),
    );

    // 1. Є незаповнені поля — заповнюємо всі й тиснемо далі.
    if (inputs.length > 0) {
      const actions: Action[] = inputs.map((inp) => ({
        kind: 'fill' as const,
        targetId: inp.id,
        value: valueFor(inp, ctx),
        reason: `поле ${inp.type ?? 'text'} "${inp.placeholder ?? step.heading}"`,
      }));
      if (nextBtn) {
        actions.push({ kind: 'click', targetId: nextBtn.id, reason: 'перехід далі' });
      }
      return actions;
    }

    // 2. Опцій немає, є тільки «далі» — це інфо-екран.
    if (options.length === 0 && nextBtn) {
      return [{ kind: 'click', targetId: nextBtn.id, reason: 'інфо-екран' }];
    }

    // 3. Є опції. На повторній спробі беремо іншу — попередня не спрацювала.
    if (options.length > 0) {
      const pick = options[Math.min(ctx.attempt, options.length - 1)];
      const actions: Action[] = [
        { kind: 'click', targetId: pick.id, reason: `опція "${pick.text.slice(0, 40)}"` },
      ];
      // Кнопка «далі» могла бути неактивною до вибору — раннер перезніме екран
      // і, якщо вона з'явилась, натисне її наступною ітерацією.
      if (nextBtn) {
        actions.push({ kind: 'click', targetId: nextBtn.id, reason: 'перехід далі' });
      }
      return actions;
    }

    return [{ kind: 'stuck', reason: 'не знайшов ні полів, ні опцій, ні кнопки далі' }];
  }
}

/** Значення для поля за типом. Кирилиця в іменах — поля не приймають латиницю й цифри. */
function valueFor(el: SnapshotElement, ctx: SolveContext): string {
  const hint = `${el.type ?? ''} ${el.placeholder ?? ''}`.toLowerCase();
  const { identity } = ctx;

  if (el.type === 'tel' || /phone|телефон/.test(hint)) return identity.phone;
  if (el.type === 'email' || /mail|пошт/.test(hint)) return identity.email;
  if (el.type === 'number' || /вік|age/.test(hint)) return identity.childAge;
  if (/батьк|parent|ваше|ім'я одного/i.test(hint)) return identity.parentName;
  return identity.childName;
}
