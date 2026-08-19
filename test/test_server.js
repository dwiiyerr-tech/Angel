import { fetchServerSignals } from './src/signals/serverClient.js';
import { SIGNAL_SERVER_URL, SIGNAL_SERVER_KEY } from './src/config.js';
console.log({ SIGNAL_SERVER_URL, SIGNAL_SERVER_KEY });
fetchServerSignals();
