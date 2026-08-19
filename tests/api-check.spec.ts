import { test } from '@playwright/test';

/** Швидка перевірка, що ключ і модель робочі. Браузер не потрібен. */
test('перевірка доступу до API', async () => {
  const key = process.env.ANTHROPIC_API_KEY;
  console.log('ключ заданий:', key ? `так (${key.slice(0, 12)}…)` : 'НІ');
  if (!key) return;

  const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
  console.log('модель:', model);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Відповідай тільки: {"ok":true}' }],
    }),
  });

  console.log('статус:', res.status);
  console.log('відповідь:', (await res.text()).slice(0, 600));
});
