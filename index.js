import { startAngel } from './src/app.js';

process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});

startAngel().catch((error) => {
  console.error(error);
  process.exit(1);
});
