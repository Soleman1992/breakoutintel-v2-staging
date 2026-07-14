// ── Zerodha adapter ──────────────────────────────────────────────────────────
//
// Normalises a Zerodha Console "Equity Holdings Statement" (XLSX or CSV) into the
// shape broker_holdings expects.
//
// This is the plugin seam. A future Kite or Upstox adapter implements the same
// interface — parseHoldings(rows) -> { asOf, summary, holdings[] } — and nothing
// downstream changes.
//
// Everything here is driven by what a real export actually contains, not by the
// documented format. Notable realities:
//
//   * The header row is NOT row 1. A preamble sits above it (client id, statement
//     title, a summary block). We locate the header by content.
//   * There is NO exchange column. Resolution happens later, in the service.
//   * Quantity is split across five columns. "Quantity Long Term" is a SUBSET of
//     "Quantity Available" (verified against the file's own Present Value), so
//     adding them would double-count.
//   * `Average Price` is NOT a reliable cost basis. After a corporate action the
//     broker's displayed average and the average implied by its own P&L disagree.
//     Observed on LLOYDSENGG: displayed 70.6420, implied 85.3490 — one row that
//     alone moved the portfolio's invested value by 8,618 rupees. We therefore
//     take the broker's per-row Unrealized P&L as authoritative and derive
//     invested value from it.

const { assertSafeCell } = require('./csvParser');

// Header cell -> our field name. Matched case-insensitively after collapsing
// whitespace, so "Quantity Pledged (Margin)" survives formatting drift.
const COLUMN_MAP = {
  'symbol':                     'symbol',
  'isin':                       'isin',
  'sector':                     'brokerSector',
  'quantity available':         'qtyAvailable',
  'quantity discrepant':        'qtyDiscrepant',
  'quantity long term':         'qtyLongTerm',
  'quantity pledged (margin)':  'qtyPledgedMargin',
  'quantity pledged (loan)':    'qtyPledgedLoan',
  'average price':              'avgPrice',
  'previous closing price':     'prevClose',
  'unrealized p&l':             'unrealizedPnl',
  'unrealized p&l pct.':        'unrealizedPnlPct',
  'unrealized p&l pct':         'unrealizedPnlPct',
};

const REQUIRED = ['symbol', 'qtyAvailable', 'avgPrice', 'prevClose', 'unrealizedPnl'];

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  // Exports may carry thousands separators or a currency symbol.
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Locate the header row by content — it is not row 1 in a real export. */
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 200); i++) {
    const cells = (rows[i] || []).map(norm);
    if (cells.includes('symbol') && cells.includes('isin')) return i;
  }
  throw new Error(
    'Could not find the holdings header row (expected a row containing "Symbol" and "ISIN"). ' +
    'Is this a Zerodha Console "Equity Holdings Statement"?'
  );
}

/**
 * Pull the statement's own summary figures out of the preamble. These are what
 * we reconcile the imported rows against — the whole point of importing is that
 * the totals match what the broker says they are.
 */
function parseSummary(rows, headerIdx) {
  const out = { investedValue: null, presentValue: null, unrealizedPnl: null, asOf: null };

  const LABELS = {
    'invested value': 'investedValue',
    'present value':  'presentValue',
    'unrealized p&l': 'unrealizedPnl',
  };

  for (let i = 0; i < headerIdx; i++) {
    const row = rows[i] || [];

    // Scan the WHOLE row, not just column A: the summary block is indented in a
    // real export, so the label does not sit in the first column. Take the next
    // non-empty cell after the label as its value.
    for (let c = 0; c < row.length; c++) {
      const field = LABELS[norm(row[c])];
      if (!field || out[field] !== null) continue;

      for (let v = c + 1; v < row.length; v++) {
        if (String(row[v] ?? '').trim() !== '') { out[field] = num(row[v]); break; }
      }
    }

    // "Equity Holdings Statement as on 2026-07-14"
    for (const cell of row) {
      const m = String(cell ?? '').match(/as on\s+(\d{4}-\d{2}-\d{2})/i);
      if (m) out.asOf = m[1];
    }
  }
  return out;
}

function classifyAsset(isin, brokerSector) {
  // Indian ISINs: INE… = company equity, INF… = mutual fund / ETF units.
  if (norm(brokerSector) === 'etf') return 'ETF';
  if (/^INF/i.test(isin || ''))     return 'ETF';
  return 'EQUITY';
}

/**
 * @param {string[][]} rows  raw grid from readXlsx() or parseCsv()
 * @returns {{asOf: string|null, summary: object, holdings: object[], warnings: string[]}}
 */
function parseHoldings(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('The file appears to be empty.');
  }

  const headerIdx = findHeaderRow(rows);
  const header    = rows[headerIdx].map(norm);
  const summary   = parseSummary(rows, headerIdx);

  // Map header text -> column index
  const col = {};
  header.forEach((h, i) => {
    const field = COLUMN_MAP[h];
    if (field && col[field] === undefined) col[field] = i;
  });

  const missing = REQUIRED.filter(f => col[f] === undefined);
  if (missing.length) {
    throw new Error(
      `Holdings file is missing required column(s): ${missing.join(', ')}. ` +
      `Found: ${header.filter(Boolean).join(' | ')}`
    );
  }

  const holdings = [];
  const warnings = [];

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row    = rows[r] || [];
    const rowNum = r + 1;                       // 1-based, matches the spreadsheet
    const symbol = String(row[col.symbol] ?? '').trim();

    if (!symbol) continue;                      // blank spacer row
    if (norm(symbol) === 'total') continue;     // a totals row, if present

    assertSafeCell(symbol, 'Symbol', rowNum);
    if (!/^[A-Z0-9&.\-]{1,30}$/i.test(symbol)) {
      warnings.push(`Row ${rowNum}: skipped — "${symbol}" is not a valid symbol.`);
      continue;
    }

    const isin         = String(row[col.isin] ?? '').trim();
    const brokerSector = String(row[col.brokerSector] ?? '').trim();
    assertSafeCell(isin,         'ISIN',   rowNum);
    assertSafeCell(brokerSector, 'Sector', rowNum);

    const qtyAvailable     = num(row[col.qtyAvailable]);
    const qtyDiscrepant    = num(row[col.qtyDiscrepant]);
    const qtyLongTerm      = num(row[col.qtyLongTerm]);
    const qtyPledgedMargin = num(row[col.qtyPledgedMargin]);
    const qtyPledgedLoan   = num(row[col.qtyPledgedLoan]);

    // Long Term is a SUBSET of Available (confirmed: using Available alone
    // reproduces the statement's Present Value exactly). Adding it double-counts.
    // Pledged and discrepant shares ARE still owned, so they belong in the total.
    const quantity = qtyAvailable + qtyDiscrepant + qtyPledgedMargin + qtyPledgedLoan;

    if (quantity <= 0) {
      warnings.push(`Row ${rowNum}: skipped ${symbol} — zero quantity.`);
      continue;
    }

    const avgPrice      = num(row[col.avgPrice]);
    const prevClose     = num(row[col.prevClose]);
    const unrealizedPnl = num(row[col.unrealizedPnl]);
    const unrealizedPct = col.unrealizedPnlPct !== undefined ? num(row[col.unrealizedPnlPct]) : null;

    // THE important line. invested = present - unrealized, using the broker's own
    // P&L. NOT quantity * avgPrice, which is wrong after a corporate action.
    const presentValue  = quantity * prevClose;
    const investedValue = presentValue - unrealizedPnl;

    // Surface the disagreement rather than hiding it — it is a real signal that
    // a corporate action has occurred on this holding.
    const impliedAvg = quantity > 0 ? investedValue / quantity : 0;
    if (avgPrice > 0 && Math.abs(impliedAvg - avgPrice) / avgPrice > 0.01) {
      warnings.push(
        `${symbol}: the broker's stated average price (${avgPrice.toFixed(4)}) disagrees with the ` +
        `average implied by its own P&L (${impliedAvg.toFixed(4)}) — usually a bonus, split or ` +
        `other corporate action. Using the P&L-implied cost basis, which matches the statement total.`
      );
    }

    holdings.push({
      symbol:            symbol.toUpperCase(),
      isin:              isin || null,
      brokerSector:      brokerSector || null,
      assetClass:        classifyAsset(isin, brokerSector),

      quantity,
      qtyAvailable,
      qtyLongTerm,
      qtyDiscrepant,
      qtyPledgedMargin,
      qtyPledgedLoan,

      avgBuyPrice:       avgPrice,
      investedValue,

      stmtPrevClose:         prevClose,
      stmtUnrealizedPnl:     unrealizedPnl,
      stmtUnrealizedPnlPct:  unrealizedPct,

      // Whitelisted source fields only. Nothing from the preamble (which holds
      // the account's Client ID) is ever copied here.
      rawData: {
        symbol, isin, sector: brokerSector,
        qtyAvailable, qtyLongTerm, qtyDiscrepant, qtyPledgedMargin, qtyPledgedLoan,
        avgPrice, prevClose, unrealizedPnl,
      },
    });
  }

  if (holdings.length === 0) {
    throw new Error('No holdings rows found below the header. Is the statement empty?');
  }

  return { asOf: summary.asOf, summary, holdings, warnings };
}

/**
 * Check the parsed rows against the statement's own summary block.
 *
 * A silent mismatch here is precisely how a portfolio ends up quietly wrong, so
 * the result is persisted on the audit row and shown in the import report.
 */
function reconcile(parsed, tolerance = 1.0) {
  const { summary, holdings } = parsed;

  const invested = holdings.reduce((s, h) => s + h.investedValue, 0);
  const present  = holdings.reduce((s, h) => s + h.quantity * h.stmtPrevClose, 0);
  const pnl      = holdings.reduce((s, h) => s + h.stmtUnrealizedPnl, 0);

  const checks = [];
  const cmp = (label, ours, theirs) => {
    if (theirs === null || theirs === undefined) return;
    const diff = Math.abs(ours - theirs);
    checks.push({ label, ours, theirs, diff, ok: diff <= tolerance });
  };

  cmp('Invested value',  invested, summary.investedValue);
  cmp('Present value',   present,  summary.presentValue);
  cmp('Unrealized P&L',  pnl,      summary.unrealizedPnl);

  // "No checks ran" must NEVER read as a pass. An empty list would otherwise
  // reconcile vacuously — reporting a clean import while having verified nothing,
  // which is exactly how a silently wrong portfolio gets shipped.
  if (checks.length === 0) {
    return {
      reconciled: false,
      checks,
      note: 'Could not read the statement summary block, so the imported totals could not be ' +
            'verified against the broker\'s own figures. The rows were parsed, but nothing confirms they are complete.',
      totals: { invested, present, pnl },
    };
  }

  const failed = checks.filter(c => !c.ok);
  return {
    reconciled: failed.length === 0,
    checks,
    note: failed.length === 0
      ? `All ${checks.length} totals match the statement.`
      : failed.map(c => `${c.label}: computed ${c.ours.toFixed(2)} vs stated ${c.theirs.toFixed(2)} (off by ${c.diff.toFixed(2)})`).join('; '),
    totals: { invested, present, pnl },
  };
}

module.exports = { parseHoldings, reconcile, findHeaderRow, parseSummary, classifyAsset, COLUMN_MAP };
