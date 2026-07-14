// ── Holdings Assistant — deterministic Q&A ───────────────────────────────────
//
// The tests that matter most here are the REFUSALS.
//
// An LLM asked "which of my companies report earnings this week?" will produce a
// confident, well-formatted, entirely fabricated list — we have no earnings
// calendar. The single most valuable property of this assistant is that it says
// "I don't have that" instead. If a future change makes it start guessing, these
// tests fail.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const HoldingsAssistant = require('../src/holdings/holdingsAssistant');

const H = [
  { symbol: 'COLAB',     broker_sector: 'SOFTWARE SERVICES', quantity: 2185, investedValue: 100510,
    currentValue: 313111, pnl: 212600, pnlPct: 211.5, weightPct: 31.9, costBasis: 46, priceOk: true, dayChangePct: 1.2, price: 143.3, exchange: 'BSE' },
  { symbol: 'MOTISONS',  broker_sector: 'RETAIL',           quantity: 1097, investedValue: 26234,
    currentValue: 15479, pnl: -10755, pnlPct: -41.0, weightPct: 1.6, costBasis: 23.91, priceOk: true, dayChangePct: -2.0, price: 14.11, exchange: 'NSE' },
  { symbol: 'SAGILITY',  broker_sector: 'SOFTWARE SERVICES', quantity: 2550, investedValue: 102402,
    currentValue: 106565, pnl: 4163, pnlPct: 4.1, weightPct: 10.9, costBasis: 40.16, priceOk: true, dayChangePct: 0.5, price: 41.79, exchange: 'NSE' },
];

const fakeHoldings  = { getHoldings: async () => ({ holdings: H }) };
const fakeAnalytics = {
  getAllocation: async () => ({
    concentration: { holdingsCount: 22, effectiveN: 5.6, topWeight: 31.9, top3Weight: 64.4, top5Weight: 80.3 },
    bySector: [
      { label: 'SOFTWARE SERVICES', weightPct: 49.2, count: 3 },
      { label: 'RETAIL',            weightPct: 5.6,  count: 3 },
    ],
  }),
  getHealth: async () => ({
    score: 41, rating: 'Needs Attention',
    scope: 'This is a risk and structure score.',
    components: [
      { key: 'concentration',   label: 'Concentration',   score: 25, rating: 'Critical', explanation: 'Largest position is 31.9%.' },
      { key: 'diversification', label: 'Diversification', score: 22, rating: 'Critical', explanation: 'Effective N is 5.6.' },
      { key: 'lossExposure',    label: 'Loss exposure',   score: 92, rating: 'Excellent', explanation: 'Little deep loss.' },
    ],
    risk: { portfolio: { volatility: 36.5, beta: 0.91, maxDrawdown: -32.4 } },
  }),
};

const mk = () => new HoldingsAssistant(fakeHoldings, fakeAnalytics, null);

// ── Refusals: the whole point ────────────────────────────────────────────────
describe('refusals — the assistant must never invent', () => {
  test('earnings calendar: says it does not have one, and does NOT name any company', async () => {
    const r = await mk().ask('u', 'Which companies report earnings this week?');

    assert.equal(r.intent, 'earnings');
    assert.match(r.answer, /do not have an earnings calendar/i);
    assert.equal(r.data, null);

    // The failure mode being guarded against: producing a plausible list anyway.
    for (const sym of H.map(h => h.symbol)) {
      assert.ok(!r.answer.includes(sym), `must not name ${sym} — we have no earnings data`);
    }
  });

  test('fundamentals: refuses P/E, ROE, debt — and does not estimate them', async () => {
    const r = await mk().ask('u', 'What is the PE ratio of my holdings?');

    assert.equal(r.intent, 'fundamentals');
    assert.match(r.answer, /no fundamental data/i);
    assert.equal(r.data, null);
    assert.ok(!/\d+\.?\d*\s*x?\s*(pe|p\/e)/i.test(r.answer), 'must not produce a P/E figure');
  });

  test('an off-topic question is refused, with what it CAN do', async () => {
    const r = await mk().ask('u', 'What is the capital of France?');

    assert.equal(r.intent, 'unknown');
    assert.ok(!/paris/i.test(r.answer), 'must not answer general knowledge');
    assert.ok(Array.isArray(r.capabilities) && r.capabilities.length > 0);
  });

  test('an empty question is refused rather than guessed at', async () => {
    const r = await mk().ask('u', '   ');
    assert.equal(r.intent, 'unknown');
  });

  test('every answer declares it came from the deterministic engine', async () => {
    for (const q of ['biggest losers', 'how diversified', 'earnings this week', 'nonsense query xyz']) {
      const r = await mk().ask('u', q);
      assert.equal(r.engine, 'deterministic');
    }
  });
});

// ── Attribution ──────────────────────────────────────────────────────────────
describe('attribution', () => {
  test('identifies the biggest drag by RUPEES, not by percentage', async () => {
    const r = await mk().ask('u', 'Which stock is hurting my portfolio the most?');

    assert.equal(r.intent, 'hurting');
    // MOTISONS loses the most money (-10,755) even though it is not the worst %.
    assert.match(r.answer, /MOTISONS/);
    assert.ok(r.data[0].symbol === 'MOTISONS');
    // And it says so, because conflating the two is the classic error.
    assert.match(r.answer, /biggest drag in RUPEES/i);
  });

  test('winners are ranked by rupees gained', async () => {
    const r = await mk().ask('u', 'show my biggest winners');
    assert.equal(r.data[0].symbol, 'COLAB');
  });

  test('losers are ranked by percentage — a different question', async () => {
    const r = await mk().ask('u', 'show my worst performers');
    assert.equal(r.data[0].symbol, 'MOTISONS');
    assert.ok(r.data[0].pnlPct < 0);
  });
});

// ── Structure ────────────────────────────────────────────────────────────────
describe('structure questions', () => {
  test('diversification leads with effective N, not the holding count', async () => {
    const r = await mk().ask('u', 'How diversified is my portfolio?');

    assert.equal(r.intent, 'diversified');
    assert.match(r.answer, /5\.6/);
    assert.match(r.answer, /behaves like/i);
    // The insight, stated: 22 names is not diversification if 3 hold the money.
    assert.match(r.answer, /does not make a portfolio diversified/i);
  });

  test('sector question names the largest exposure with its weight', async () => {
    const r = await mk().ask('u', 'Which sectors am I overweight in?');
    assert.equal(r.intent, 'sector');
    assert.match(r.answer, /SOFTWARE SERVICES/);
    assert.match(r.answer, /49\.2/);
  });

  test('risk question surfaces genuinely weak components, worst first', async () => {
    const r = await mk().ask('u', 'What are my largest risks?');

    assert.equal(r.intent, 'risk');
    assert.match(r.answer, /41\/100/);
    assert.equal(r.data.weakest[0].key, 'diversification');   // 22, the lowest
    assert.equal(r.data.weakest[1].key, 'concentration');     // 25
  });

  // Regression: taking "the three lowest" presented a 92/100 component as a risk
  // purely because it ranked last among the ones that happened to be computable.
  // A strength must never be listed as a danger.
  test('a strong component is NEVER listed as a risk', async () => {
    const r = await mk().ask('u', 'What are my largest risks?');
    assert.ok(!r.answer.includes('Loss exposure'), 'a 92/100 component is not a risk');
    assert.ok(!r.data.weakest.some(c => c.score >= 65));
  });

  test('a healthy portfolio is told it has no weak areas, not given a bottom-3', async () => {
    const strong = {
      ...fakeAnalytics,
      getHealth: async () => ({
        score: 88, rating: 'Excellent', scope: 'Risk and structure only.',
        components: [
          { key: 'concentration',   label: 'Concentration',   score: 85, rating: 'Excellent', explanation: 'Balanced.' },
          { key: 'diversification', label: 'Diversification', score: 90, rating: 'Excellent', explanation: 'Well spread.' },
        ],
        risk: { portfolio: {} },
      }),
    };
    const r = await new HoldingsAssistant(fakeHoldings, strong, null).ask('u', 'what are my risks');

    assert.match(r.answer, /no individual component scores below/i);
    assert.equal(r.data.weakest.length, 0);
  });
});

// ── Sector comparison ────────────────────────────────────────────────────────
describe('compare', () => {
  test('matches a sector named in the question', async () => {
    const r = await mk().ask('u', 'Compare my software services holdings');
    assert.equal(r.intent, 'compare');
    assert.match(r.answer, /COLAB/);
    assert.match(r.answer, /SAGILITY/);
    assert.ok(!r.answer.includes('MOTISONS'), 'RETAIL holding must not appear in a SOFTWARE comparison');
  });

  test('an unrecognised sector is refused, and the real sectors are listed', async () => {
    const r = await mk().ask('u', 'Compare my pharmaceutical holdings');
    assert.equal(r.intent, 'unknown');
    assert.match(r.answer, /SOFTWARE SERVICES/);   // tells you what you actually own
  });
});

// ── Today ────────────────────────────────────────────────────────────────────
describe('today', () => {
  test('computes the day P&L from live prices', async () => {
    const r = await mk().ask('u', 'How did my portfolio do today?');
    assert.equal(r.intent, 'today');
    assert.ok(Number.isFinite(r.data.dayPnl));
    assert.equal(r.data.total, 3);
  });

  test('says so when no live prices exist, rather than reporting a stale day move', async () => {
    const stale = { getHoldings: async () => ({ holdings: H.map(h => ({ ...h, priceOk: false })) }) };
    const a = new HoldingsAssistant(stale, fakeAnalytics, null);
    const r = await a.ask('u', 'how did my portfolio do today');

    assert.match(r.answer, /no live prices/i);
    assert.equal(r.data, null);
  });
});
