# DEGEN BASIC TRADING by Obicle - Analysis & Implementation Notes

## Ringkasan Guide

Guide ini membahas strategi trading meme coin di Solana (Pump.fun) dari perspektif technical analysis on-chain.

---

## 1. RISK MANAGEMENT

### Do's:
- **Jangan all-in** — gunakan sebagian kecil modal per trade
- Kalau wallet 1 SOL, maksimal 0.1 SOL per trade (10% rule)
- Gunakan trading terminal (Padre/Trojan) untuk pantau chart & pergerakan arah
- Kontrol emosi, hindari revenge trade

### Don'ts:
- All-in seluruh wallet
- IKUT Kol Farming engagement (artificial hype)
- Top blast tanpa tunggu titik entry tepat
- Ikut kelas berbayar / titip dana ke orang lain

---

## 2. SCREENING (Pencarian Koin)

### Kriteria:
1. Pilih koin yang sudah **trending/hot** di terminal
2. Usia koin **minimal 1 jam** (hindari yang baru saja launch)
3. Market cap **minimal 150K USD**
4. Cek **Total Fee Paid (Global Fee)** — rasio sehat: **1:10K terhadap mcap**
   - Contoh: mcap 150K → Total Fee Paid wajar = 15 SOL
   - Ini mengindikasikan orang betul-betul trading koin ini (real volume)

---

## 3. TECHNICAL INDICATORS

### Indikator yang Digunakan:
- **EMA** (Exponential Moving Average) — untuk trend direction
- **Stoch RSI** — default setting, untuk overbought/oversold

### Timeframe berdasarkan umur koin:
| Umur Koin | Timeframe |
|-----------|-----------|
| 1-4 jam   | 15 detik  |
| 4-48 jam  | 1 menit & 5 menit |
| >48 jam   | 15 menit  |

---

## 4. ENTRY STRATEGY

### Sinyal Entry:
- Harga/candle **mendekati EMA**
- **Stoch RSI bottoming** (oversold area)
- **Candle closure** di atas key level (EMA/Fibonacci)
- Konfirmasi dengan **2-3 candle closure pattern**

### Entry Patterns:

**Pattern 1: Candle 2 Closure (Bullish)**
- Candle 1: menyentuh key level, close DI ATAS key level
- Entry: di candle 2

**Pattern 2: Candle 3 Closure (Bullish)**
- Candle 1: close di atas key level
- Candle 2: menyentuh key level
- Candle 3: close candle 2 di ATAS candle 1
- Entry: di candle 3

### Mode:
- **Continuous** — entry saat trend berlanjut mendekati EMA
- **Reversal** — entry saat reversal dari key level

---

## 5. EXIT STRATEGY

### Sinyal Exit:
- **Stoch RSI sudah di puncak** (overbought, >80)
- Harga mulai menunjukkan penurunan setelah RSI puncak
- Ceritainya: "when RSI sudah di atas, harga menunjukkan penurunan"

---

## 6. RECOMMENDED TOOLS

- **Trading Terminal**: Padre atau Telegram-based Trojan
- **Wallet**: OKX (daftar via Telegram/Gmail)
- **Chart**: Built-in chart di terminal + Stoch RSI overlay
