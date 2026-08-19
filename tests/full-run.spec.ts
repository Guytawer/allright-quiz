import { test, expect } from '@playwright/test';
import { runQuiz } from '../src/runner';
import { LlmSolver } from '../src/solvers/llm';
import { HeuristicSolver } from '../src/solvers/heuristic';
import { makeIdentity } from '../src/testData';
import { BrowserOutcomeVerifier } from '../src/verify';

/**
 * Повний сценарій: агент проходить квіз будь-яким шляхом, після чого
 * детермінована перевірка каже, чи є бізнес-результат.
 *
 * СТВОРЮЄ РЕАЛЬНІ СУТНОСТІ. Запускається тільки з ALLOW_SUBMIT=1.
 */
test('реєстрація завершується створенням користувача і бронюванням', async ({ page }) => {
  test.setTimeout(15 * 60_000);

  const allowSubmit = process.env.ALLOW_SUBMIT === '1';
  test.skip(
    !allowSubmit,
    'Пропущено: створює реальні сутності на stage. Запуск — з ALLOW_SUBMIT=1.',
  );

  const identity = makeIdentity();

  console.log(`тестові дані цього прогону: ${identity.email}`);

  const llm = new LlmSolver();

  const run = await runQuiz(page, {
    entryUrl: 'https://stage.allright.com/uk/app/sign-up/long/charlie/age-range',
    identity,
    solver: llm,
    fallback: new HeuristicSolver(),
    allowSubmit: true,
  });

  // Даємо застосунку доробити після останнього кроку.
  await page.waitForTimeout(4000);

  const outcome = await new BrowserOutcomeVerifier().verify(identity, run, page);

  console.log('\n— варіант:', run.servedVariant);
  console.log('— кроків:', run.steps.length, '| евристикою:', run.steps.filter((s) => s.solver === 'heuristic').length);
  console.log('— викликів моделі:', llm.usage.calls, `(${llm.usage.inputTokens} вх / ${llm.usage.outputTokens} вих)`);
  console.log('— зупинка:', run.stoppedBecause);
  console.log('— тертя:', run.friction.length);
  for (const f of run.friction) console.log(`   ${f.slug}: ${f.what}`);
  console.log('\n— результат:', JSON.stringify(outcome, null, 2));
  console.log('\n— записи в API:');
  for (const r of run.api.filter((r) => ['POST', 'PUT', 'PATCH'].includes(r.method))) {
    console.log(`   ${r.method} ${r.url} → ${r.status}`);
  }

  // Асерт на бізнес-результаті, а не на кроках квіза: він однаковий у будь-якому
  // A/B-варіанті, тому не потребує переписування після зміни експерименту.
  expect(outcome.userCreated, `користувач не створений. Докази: ${outcome.evidence.join('; ')}`).toBe(true);
  expect(outcome.trialBooked, `пробний не заброньований. Докази: ${outcome.evidence.join('; ')}`).toBe(true);
});
