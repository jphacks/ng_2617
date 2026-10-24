export const EDIT_LOCK_TTL_MS = 5 * 60_000;
export const EDIT_REPLY_TIMEOUT_MS = 10_000;
export const WORD_ADDITION_DELAY_MS = 30_000;
export const WORD_ADDITION_COUNT = 3;

/** テストでは時計と一緒に差し替える。戻り値で予約を取り消す。 */
export type Schedule = (callback: () => void, delayMs: number) => () => void;
export const scheduleTimeout: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};
