import { TestIdentity } from './types';

/**
 * Тестові дані на прогін.
 *
 * Телефон обов'язково унікальний: у першій версії він був захардкоджений, і після
 * першого ж успішного повного прогону номер виявився зайнятим — продукт почав
 * кидати на екран входу, а агент зациклився між реєстрацією і логіном.
 *
 * Патерн email навмисно впізнаваний, щоб такі реєстрації можна було відфільтрувати.
 */
export function makeIdentity(): TestIdentity {
  const stamp = String(Date.now());
  const suffix = stamp.slice(-7); // 7 цифр після коду оператора

  return {
    stamp,
    parentName: 'Олена',
    childName: 'Марко',
    childAge: '8',
    email: `qa-agent-${stamp}@example.com`,
    phone: `093${suffix}`,
  };
}
