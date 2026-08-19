import 'dotenv/config';
import axios from 'axios';
import { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, LLM_TIMEOUT_MS } from './src/config.js';

async function testLLM() {
  console.log('Testing LLM Connection...');
  console.log(`URL: ${LLM_BASE_URL}`);
  console.log(`Model: ${LLM_MODEL}`);
  
  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are a test bot.' },
        { role: 'user', content: 'Reply with the word "WORKING" in JSON format {"status": "WORKING"}' },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    
    console.log('LLM Response Status:', res.status);
    console.log('LLM Response Data:', res.data?.choices?.[0]?.message?.content);
    console.log('LLM is WORKING.');
  } catch (error) {
    console.error('LLM Request Failed:');
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(error.response.data);
    } else {
      console.error(error.message);
    }
  }
}

testLLM();
