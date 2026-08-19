import { test } from '@playwright/test';
import { runQuiz } from '../src/runner';
import { LlmSolver } from '../src/solvers/llm';
import { HeuristicSolver } from '../src/solvers/heuristic';
import { makeIdentity } from '../src/testData';

/**
 * Агентний прохід. Рішення приймає модель, евристика лишається фолбеком:
 * якщо API недоступний або відповідь не парситься, прогін не падає, а
 * продовжується гіршим солвером — і це записується в лог тертя.
 *
 * Потрібен ANTHROPIC_API_KEY у середовищі.
 */
test('агентний прохід квіза', async ({ page }) => {
  test.setTimeout(12 * 60_000);

  const identity = makeIdentity();
  const llm = new LlmSolver();

  const result = await runQuiz(page, {
    entryUrl: 'https://stage.allright.com/uk/app/sign-up/long/charlie/age-range',
    identity,
    solver: llm,
    fallback: new HeuristicSolver(),
    allowSubmit: process.env.ALLOW_SUBMIT === '1',
  });

  console.log('\n— зупинка:', result.stoppedBecause);
  console.log('— кроків:', result.steps.length);
  console.log(
    '— з них евристикою:',
    result.steps.filter((s) => s.solver === 'heuristic').length,
  );
  console.log('— викликів моделі:', llm.usage.calls);
  console.log(
    `— токени: ${llm.usage.inputTokens} вх / ${llm.usage.outputTokens} вих`,
  );
  console.log('— записів тертя:', result.friction.length);
  for (const f of result.friction) {
    console.log(`   ${f.slug} (спроба ${f.attempt}): ${f.what}`);
  }
});
