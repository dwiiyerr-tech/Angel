import { bot } from './src/telegram/bot.js';
import { TELEGRAM_CHAT_ID } from './src/config.js';

async function send() {
  console.log('Sending report to Telegram...');
  try {
    await bot.sendDocument(TELEGRAM_CHAT_ID, '/root/Kaiser.charon/charon_architecture.md', {
      caption: '🚀 Laporan Arsitektur Charon & Peta Logika AI (Mermaid.js) berhasil dibuat!'
    });
    console.log('Successfully sent to Telegram!');
  } catch (err) {
    console.error('Failed to send:', err.message);
  }
  process.exit(0);
}
send();
