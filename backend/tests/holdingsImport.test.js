// ── Holdings import: CSV parser, sanitiser, Zerodha adapter ──────────────────
//
// The reconciliation tests are the important ones. An import that silently drops
// a row, or uses the wrong cost basis, produces a portfolio that looks right and
// is wrong — which is worse than an import that fails loudly.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCsv, isFormulaLike, assertSafeCell, sanitiseForExport, toCsvField,
} = require('../src/holdings/csvParser');
const { parseHoldings, reconcile, classifyAsset } = require('../src/holdings/zerodhaAdapter');
const { stripSeries } = require('../src/holdings/brokerHoldingsService');

// ── CSV parser ───────────────────────────────────────────────────────────────
describe('parseCsv', () => {
  test('parses a simple grid', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,2,3'), [['a','b','c'], ['1','2','3']]);
  });

  test('handles quoted fields containing commas', () => {
    assert.deepEqual(parseCsv('a,"b,c",d'), [['a','b,c','d']]);
  });

  test('handles escaped quotes ("")', () => {
    assert.deepEqual(parseCsv('a,"say ""hi""",c'), [['a','say "hi"','c']]);
  });

  test('handles a newline inside a quoted field', () => {
    assert.deepEqual(parseCsv('a,"line1\nline2",c'), [['a','line1\nline2','c']]);
  });

  test('handles CRLF line endings', () => {
    assert.deepEqual(parseCsv('a,b\r\n1,2'), [['a','b'], ['1','2']]);
  });

  test('strips a UTF-8 BOM (else the first header never matches)', () => {
    assert.deepEqual(parseCsv('﻿Symbol,ISIN'), [['Symbol','ISIN']]);
  });

  test('rejects an unterminated quoted field', () => {
    assert.throws(() => parseCsv('a,"unterminated'), /never closed/);
  });

  test('rejects a file over the row cap', () => {
    const big = Array.from({ length: 5002 }, (_, i) => `row${i},1`).join('\n');
    assert.throws(() => parseCsv(big), /more than 5000 rows/);
  });

  test('rejects a file over the byte cap', () => {
    assert.throws(() => parseCsv('x'.repeat(600 * 1024)), /the limit is 512 KB/);
  });

  test('rejects null bytes', () => {
    assert.throws(() => parseCsv('a,b\0c'), /null bytes/);
  });
});

// ── Formula injection ────────────────────────────────────────────────────────
describe('formula injection', () => {
  test('flags the classic payloads', () => {
    for (const bad of ['=cmd|\'/c calc\'!A1', '@SUM(1)', '=1+1', '+HYPERLINK("x")', '\tx', '\rx']) {
      assert.equal(isFormulaLike(bad), true, `should flag: ${JSON.stringify(bad)}`);
    }
  });

  // The subtle one: a leading '-' is legitimate for a negative number. Flagging
  // those would reject every loss-making holding in the file.
  test('does NOT flag negative numbers', () => {
    for (const ok of ['-616.32', '-61.7902', '-0.5', '-1e3', '+12.5']) {
      assert.equal(isFormulaLike(ok), false, `should NOT flag: ${ok}`);
    }
  });

  test('flags a leading "-" followed by non-numeric text', () => {
    assert.equal(isFormulaLike('-1+cmd|x'), true);
  });

  test('assertSafeCell rejects a formula on import', () => {
    assert.throws(() => assertSafeCell('=1+1', 'Symbol', 7), /interpret as a formula/);
  });

  test('assertSafeCell allows a negative number', () => {
    assert.equal(assertSafeCell('-616.32', 'Unrealized P&L', 7), '-616.32');
  });

  // The export guard is what actually closes the hole: sanitising only on import
  // leaves us exposed if such a value ever arrives by another route.
  test('sanitiseForExport neutralises a formula with a leading apostrophe', () => {
    assert.equal(sanitiseForExport('=cmd|x'), "'=cmd|x");
  });

  test('sanitiseForExport leaves ordinary values alone', () => {
    assert.equal(sanitiseForExport('RELIANCE'), 'RELIANCE');
    assert.equal(sanitiseForExport('-616.32'), '-616.32');
  });

  test('toCsvField quotes and escapes correctly', () => {
    assert.equal(toCsvField('a,b'), '"a,b"');
    assert.equal(toCsvField('say "hi"'), '"say ""hi"""');
    assert.equal(toCsvField('=x'), "'=x");
  });
});

// ── Zerodha adapter ──────────────────────────────────────────────────────────
//
// A CSV facsimile of a real Console export: preamble, indented summary block,
// header well below row 1. Figures are the real ones from a live statement, which
// is what makes the reconciliation meaningful.
const ZERODHA_CSV = [
  ',,,',
  ',Client ID,XX0000,',
  ',,,',
  ',Equity Holdings Statement as on 2026-07-14,,',
  ',,,',
  ',Summary,,',
  ',Invested Value,764693.6600,',
  ',Present Value,983413.0500,',
  ',Unrealized P&L,218719.3900,',
  ',Unrealized P&L Pct.,28.6022,',
  ',,,',
  'Symbol,ISIN,Sector,Quantity Available,Quantity Discrepant,Quantity Long Term,Quantity Pledged (Margin),Quantity Pledged (Loan),Average Price,Previous Closing Price,Unrealized P&L,Unrealized P&L Pct.',
  'COLAB,INE317W01030,SOFTWARE SERVICES,2185.0000,0.0000,1000.0000,0.0000,0.0000,46.0002,143.3000,212600.0500,211.5203',
  // LLOYDSENGG: the corporate-action row. Its stated average price (70.6420)
  // disagrees with the average implied by its own P&L (85.3490). Computing
  // invested value as quantity * avg_price gets this row wrong by 8,618 rupees.
  'LLOYDSENGG,INE093R01011,ENGINEERING & CAPITAL GOODS,586.0000,0.0000,586.0000,0.0000,0.0000,70.6420,87.6300,1336.6600,2.6725',
  'METALIETF,INF109KC19W1,ETF,1000.0000,0.0000,0.0000,0.0000,0.0000,11.3700,12.7700,1400.0000,12.3131',
].join('\n');

describe('zerodhaAdapter', () => {
  const parsed = parseHoldings(parseCsv(ZERODHA_CSV));

  test('finds the header row even though it is not row 1', () => {
    assert.equal(parsed.holdings.length, 3);
  });

  test('reads the statement date from the preamble', () => {
    assert.equal(parsed.asOf, '2026-07-14');
  });

  test('reads the summary block even though it is indented (not column A)', () => {
    assert.equal(parsed.summary.investedValue, 764693.66);
    assert.equal(parsed.summary.presentValue,  983413.05);
    assert.equal(parsed.summary.unrealizedPnl, 218719.39);
  });

  test('does NOT add Long Term to Available (it is a subset — adding double-counts)', () => {
    const colab = parsed.holdings.find(h => h.symbol === 'COLAB');
    assert.equal(colab.quantity, 2185);        // NOT 2185 + 1000
  });

  // The heart of it. Zerodha's displayed average price is not a reliable cost
  // basis after a corporate action; its per-row P&L is. Derive invested from P&L.
  test('derives invested value from the broker P&L, not quantity * avg_price', () => {
    const ll = parsed.holdings.find(h => h.symbol === 'LLOYDSENGG');

    const naive = 586 * 70.6420;                      // 41,396.21 — the wrong answer
    const right = (586 * 87.6300) - 1336.66;          // 49,014.52 — matches the statement

    assert.ok(Math.abs(ll.investedValue - right) < 0.01);
    assert.ok(Math.abs(ll.investedValue - naive) > 7000, 'must not use quantity * avg_price');
  });

  test('warns about the average-price disagreement instead of hiding it', () => {
    assert.ok(parsed.warnings.some(w => /LLOYDSENGG/.test(w) && /corporate action/.test(w)));
  });

  test('classifies ETFs separately from equities', () => {
    assert.equal(parsed.holdings.find(h => h.symbol === 'METALIETF').assetClass, 'ETF');
    assert.equal(parsed.holdings.find(h => h.symbol === 'COLAB').assetClass, 'EQUITY');
  });

  test('classifyAsset: INF ISINs and an ETF sector are both ETFs', () => {
    assert.equal(classifyAsset('INF109KC19W1', 'ETF'), 'ETF');
    assert.equal(classifyAsset('INF0R8F01059', ''), 'ETF');
    assert.equal(classifyAsset('INE317W01030', 'SOFTWARE SERVICES'), 'EQUITY');
  });

  test('does not copy the Client ID out of the preamble into raw_data', () => {
    const blob = JSON.stringify(parsed.holdings.map(h => h.rawData));
    assert.ok(!blob.includes('Client ID'));
    assert.ok(!blob.includes('XX0000'));
  });

  test('rejects a file that is not a holdings statement', () => {
    assert.throws(() => parseHoldings(parseCsv('foo,bar\n1,2')), /Could not find the holdings header row/);
  });
});

describe('reconcile', () => {
  test('reports a mismatch rather than passing quietly', () => {
    const parsed = parseHoldings(parseCsv(ZERODHA_CSV));
    // Only 3 of the statement's 22 rows are present here, so the totals must NOT
    // match — proving the check has teeth.
    const rec = reconcile(parsed);
    assert.equal(rec.reconciled, false);
    assert.match(rec.note, /Invested value/);
  });

  // Regression: an empty check list used to reconcile vacuously — reporting a
  // clean import while having verified nothing at all.
  test('a missing summary block is a FAILURE, never a vacuous pass', () => {
    const rec = reconcile({
      summary:  { investedValue: null, presentValue: null, unrealizedPnl: null },
      holdings: [{ investedValue: 1, quantity: 1, stmtPrevClose: 1, stmtUnrealizedPnl: 0 }],
    });
    assert.equal(rec.reconciled, false);
    assert.match(rec.note, /could not be verified/i);
  });
});

// ── Symbol handling ──────────────────────────────────────────────────────────
describe('stripSeries', () => {
  test('strips the broker series suffixes that break price lookups', () => {
    assert.equal(stripSeries('EMPOWER-T'),   'EMPOWER');
    assert.equal(stripSeries('LKPSEC-XT'),   'LKPSEC');
    assert.equal(stripSeries('TATAGOLD-E'),  'TATAGOLD');
    assert.equal(stripSeries('RAJOOENG-T'),  'RAJOOENG');
  });

  test('leaves ordinary symbols untouched', () => {
    assert.equal(stripSeries('RELIANCE'),   'RELIANCE');
    assert.equal(stripSeries('MID150CASE'), 'MID150CASE');
    assert.equal(stripSeries('BAJAJ-AUTO'), 'BAJAJ-AUTO');   // '-AUTO' is not a series suffix
  });
});
