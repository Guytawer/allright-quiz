/**
 * ПРИПУЩЕННЯ: у мене немає доступу до реального бекенд-API/БД стейджа,
 * тож цей клієнт — контракт-заглушка, яка показує, ЯК саме мала б виглядати
 * детермінована перевірка бізнес-результату (частина А, п.1: "точно
 * перевіряємо через API та бекенд").
 */

export interface UserRecord {
  exists: boolean;
  userId?: string;
}

export interface TrialBookingRecord {
  exists: boolean;
  bookingId?: string;
  status?: string;
}

const BACKEND_BASE_URL = process.env.QUIZ_BACKEND_API_URL ?? 'https://stage.allright.com/internal/api';

export async function findUserByEmail(email: string): Promise<UserRecord> {
  const response = await fetch(`${BACKEND_BASE_URL}/qa/users?email=${encodeURIComponent(email)}`);
  if (!response.ok) return { exists: false };
  const data = await response.json();
  return { exists: Boolean(data?.id), userId: data?.id };
}

export async function findTrialBookingByUserId(userId: string): Promise<TrialBookingRecord> {
  const response = await fetch(`${BACKEND_BASE_URL}/qa/bookings?userId=${encodeURIComponent(userId)}`);
  if (!response.ok) return { exists: false };
  const data = await response.json();
  return { exists: Boolean(data?.id), bookingId: data?.id, status: data?.status };
}

export async function waitForUserAndBooking(
  email: string,
  { retries = 5, delayMs = 2000 }: { retries?: number; delayMs?: number } = {},
): Promise<{ user: UserRecord; booking: TrialBookingRecord }> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const user = await findUserByEmail(email);
    if (user.exists && user.userId) {
      const booking = await findTrialBookingByUserId(user.userId);
      if (booking.exists) {
        return { user, booking };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return { user: { exists: false }, booking: { exists: false } };
}
