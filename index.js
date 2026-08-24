import { startAngel } from './src/app.js';
import { startControlPlaneRuntime } from './src/controlPlane/runtime.js';
import { startFastHunterRuntime } from './src/research/fastHunterRuntime.js';

process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});

startAngel()
  .then(() => {
    startFastHunterRuntime();
    return startControlPlaneRuntime();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });