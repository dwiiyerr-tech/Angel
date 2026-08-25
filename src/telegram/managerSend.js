import { TELEGRAM_TOPIC_ID } from '../config.js';
import { bot } from './bot.js';

function managerMessageOptions(extra = {}) {
  return {
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...extra,
  };
}

export async function sendManagerMessage(chatId, text, extra = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await bot.sendMessage(chatId, text, managerMessageOptions(extra));
    } catch (error) {
      lastError = error;
      const status = Number(error?.response?.statusCode || error?.response?.status || 0);
      const retryable = status === 429 || status >= 500 || /EFATAL|AggregateError|ECONNRESET|ETIMEDOUT|socket hang up/i.test(error?.message || '');
      if (!retryable || attempt === 3) throw error;
      const retryAfterMs = Number(error?.response?.body?.parameters?.retry_after || 0) * 1000;
      await new Promise(resolve => setTimeout(resolve, Math.max(retryAfterMs, attempt * 1000)));
    }
  }
  throw lastError;
}
