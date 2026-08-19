import { test } from '@playwright/test';
import { runQuiz } from '../src/runner';
import { HeuristicSolver } from '../src/solvers/heuristic';

/**
 * Димова перевірка каркаса: той самий прохід, що робила розвідка,
 * але вже через раннер і солвер. LLM тут не бере участі.
 */
test('прохід квіза евристичним солвером', async ({ page }) => {
  test.setTimeout(4 * 60_000);

  const stamp = String(Date.now());

  const result = await runQuiz(page, {
    entryUrl: 'https://stage.allright.com/uk/app/sign-up/long/charlie/age-range',
    identity: {
      stamp,
      parentName: 'Олена',
      childName: 'Марко',
      childAge: '8',
      email: `qa-agent-${stamp}@example.com`,
      phone: '0931112233',
    },
    solver: new HeuristicSolver(),
    allowSubmit: false, // за дефолтом нічого не створюємо
    pinVariant: process.env.PIN_VARIANT,
  });

  console.log('\n— зупинка:', result.stoppedBecause);
  console.log('— кроків:', result.steps.length);
  console.log('— записів тертя:', result.friction.length);
  for (const f of result.friction) {
    console.log(`   ${f.slug} (спроба ${f.attempt}): ${f.what}`);
  }
});
