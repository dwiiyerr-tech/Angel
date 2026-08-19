import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config.js';

const isPollingEnabled = process.env.TELEGRAM_POLLING !== 'false';

export const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  // FIX: Mengurangi spam request ke Telegram dengan menaikkan interval (3 detik) 
  // dan memperpanjang durasi koneksi (timeout 30 detik) agar tidak bolak-balik buka koneksi.
  polling: isPollingEnabled ? { interval: 3000, autoStart: true, params: { timeout: 30 } } : false
});

bot.on('polling_error', (error) => {
  const msg = error?.message || String(error);
  // Suppress spammy network errors from Telegram API to keep logs clean
  if (msg.includes('409') || 
      msg.includes('429') || 
      msg.includes('502') || 
      msg.includes('503') || 
      msg.includes('EFATAL') || 
      msg.includes('socket hang up') || 
      msg.includes('ECONNRESET')) {
    return; 
  }
  console.error('[telegram] polling error:', msg);
});
