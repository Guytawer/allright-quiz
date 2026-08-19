/**
 * Спільні типи. Ключове тут — інтерфейс Solver: він єдина точка,
 * де евристика замінюється на LLM і навпаки.
 */

/** Один інтерактивний елемент на екрані. */
export interface SnapshotElement {
  /** Тимчасовий id, проставлений як data-agent-id — клікаємо по ньому, а не по тексту. */
  id: number;
  tag: string;
  role: string | null;
  type: string | null;
  text: string;
  placeholder: string | null;
  disabled: boolean;
  isInput: boolean;
  /** Чи виглядає елемент як уже вибраний (для мультиселектів). */
  selected: boolean;
}

/** Згорнутий опис поточного екрана — усе, що потрібно, щоб вирішити, що робити. */
export interface StepSnapshot {
  slug: string;
  url: string;
  heading: string;
  elements: SnapshotElement[];
  /** Видимі повідомлення про помилку на екрані — те, що продукт відповів агенту. */
  errors: string[];
  /** Чи знімок узятий з модалки (вона перехоплює взаємодію). */
  inModal: boolean;
}

/**
 * Дія, яку солвер пропонує виконати.
 * `done` — солвер вважає, що квіз пройдено.
 * `stuck` — солвер не бачить, що робити (це сигнал, а не помилка).
 */
export type Action =
  | { kind: 'click'; targetId: number; reason: string }
  | { kind: 'fill'; targetId: number; value: string; reason: string }
  | { kind: 'done'; reason: string }
  | { kind: 'stuck'; reason: string };

/** Дані тестового користувача — щоб солвер знав, чим заповнювати поля. */
export interface TestIdentity {
  stamp: string;
  parentName: string;
  childName: string;
  childAge: string;
  email: string;
  phone: string;
}

export interface SolveContext {
  identity: TestIdentity;
  /** Яка це спроба на цьому ж кроці. >0 означає, що попередня дія не дала прогресу. */
  attempt: number;
  /** Що вже пробували на цьому кроці — щоб не повторювати те саме. */
  triedOnThisStep: string[];
}

export interface Solver {
  readonly name: string;
  decide(step: StepSnapshot, ctx: SolveContext): Promise<Action[]>;
}

/**
 * Запис про тертя: місце, де агенту було важко.
 * Це не помилка прогону, але це те, на чому реальний користувач міг би піти.
 */
export interface Friction {
  slug: string;
  attempt: number;
  what: string;
}

export interface RunResult {
  servedVariant: string | null;
  entryUrl: string;
  finalUrl: string;
  steps: {
    i: number;
    slug: string;
    solver: string;
    actions: string[];
    progressed: boolean;
  }[];
  friction: Friction[];
  reachedEnd: boolean;
  stoppedBecause: string;
  /** Мережеві виклики за час проходу — доказова база для перевірки результату. */
  api: { method: string; url: string; status: number | null }[];
}
