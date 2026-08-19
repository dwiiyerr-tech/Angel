import 'dotenv/config';
// Test file for fallback LLM and PumpFun

import axios from 'axios';
import WebSocket from 'ws';

async function testFallbackLLM() {
  console.log('--- Testing Fallback LLM ---');
  const url = process.env.LLM_FALLBACK_BASE_URL;
  const key = process.env.LLM_FALLBACK_API_KEY;
  const model = process.env.LLM_FALLBACK_MODEL;
  console.log(`URL: ${url} | Model: ${model}`);
  
  try {
    const res = await axios.post(`${url.replace(/\/$/, '')}/chat/completions`, {
      model: model,
      temperature: 0.2,
      messages: [{ role: 'user', content: 'Say "WORKING"' }]
    }, {
      timeout: 10000,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    });
    console.log('Fallback LLM Status:', res.status);
    console.log('Fallback LLM is WORKING.');
  } catch (e) {
    console.error('Fallback LLM Failed:', e.message);
  }
}

async function testPumpFun() {
  console.log('\n--- Testing PumpPortal WebSocket ---');
  const apiKey = process.env.PUMPPORTAL_API_KEY;
  if (!apiKey) {
    console.log('No PUMPPORTAL_API_KEY found.');
    return;
  }
  
  const wsUrl = `wss://pumpportal.fun/api/data?api-key=${apiKey}`;
  const ws = new WebSocket(wsUrl);
  
  let success = false;
  
  ws.on('open', () => {
    console.log('PumpPortal WS Connected.');
    success = true;
    // Subscribe to new token creations as a test
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    
    // Close after a short delay
    setTimeout(() => {
      console.log('Closing PumpPortal WS (successful connection).');
      ws.close();
      if (success) {
          console.log('PumpFun API Key is WORKING.');
      }
      process.exit(0);
    }, 2000);
  });
  
  ws.on('error', (err) => {
    console.error('PumpPortal WS Error:', err.message);
    process.exit(1);
  });
}

async function main() {
  await testFallbackLLM();
  await testPumpFun();
}

main();
