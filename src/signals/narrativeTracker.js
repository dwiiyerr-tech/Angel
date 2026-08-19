import { db } from '../db/connection.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';

export async function processNarrativeTrack(candidate) {
  const mint = candidate.token?.mint;
  const symbol = (candidate.token?.symbol || '').toUpperCase();
  const twitterUrl = candidate.token?.twitter || candidate.twitterNarrative?.url;

  if (!mint || !symbol) return null;

  // 1. Fetch tweet data
  const narrativeData = twitterUrl ? await fetchTwitterNarrative(twitterUrl, null) : null;
  const tweetMetrics = narrativeData?.metrics;
  const likes = tweetMetrics?.likes || 0;
  const retweets = tweetMetrics?.retweets || 0;
  const replies = tweetMetrics?.replies || 0;

  // 2. DeepSeek Rule: Fake Bot Hype Detection
  const replyRatio = retweets > 0 ? (replies / retweets) : 0;
  const isAuthentic = (retweets < 30 || replyRatio >= 0.03) ? 1 : 0;

  // 3. Velocity & Social Score
  const socialScore = Math.min(100, Math.round((replies * 3) + (likes * 0.5) + (retweets * 1.5)));

  // 4. Opus Rule: Narrative Stage
  const priceChange1h = Number(candidate.metrics?.priceChange1h || 0);
  let stage = 'BIRTH';
  if (priceChange1h > 300) {
    stage = 'SATURATION'; // Parabolic Top Trap
  } else if (socialScore >= 50 && isAuthentic === 1) {
    stage = 'SURGE'; // Sweet Spot
  }

  // 5. Store in SQLite
  const nowMs = Date.now();
  db.prepare(`
    INSERT INTO narrative_signals (
      mint, ticker, tweet_velocity_5m, narrative_theme, organic_score, is_authentic, stage, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET
      tweet_velocity_5m = tweet_velocity_5m + 1,
      organic_score = excluded.organic_score,
      is_authentic = excluded.is_authentic,
      stage = excluded.stage,
      updated_at_ms = excluded.updated_at_ms
  `).run(mint, symbol, 1, 'GENERAL_MEME', socialScore, isAuthentic, stage, nowMs);

  return { symbol, socialScore, isAuthentic: isAuthentic === 1, stage };
}
