// ── Broker Holdings Service ──────────────────────────────────────────────────
//
// Personal Portfolio Intelligence — broker-synced holdings imported from Zerodha
// Console exports.
//
// DISTINCT from the existing portfolioService/transactionService, which manage the
// `positions` + `trade_history` scanner trade journal. This module never reads or
// writes those tables.
//
// Derived figures (current value, live P&L, portfolio weight, returns) are computed
// HERE, on read. Only facts are stored. The one apparent exception — invested_value
// — is itself a fact: it is what the statement said at import time and must not move
// when prices move.

const crypto = require('crypto');
const { UNIVERSE_MAP } = require('../services/universe');
const { readXlsx }     = require('./xlsxReader');
const { parseCsv }     = require('./csvParser');
const zerodha          = require('./zerodhaAdapter');

const MAX_FILE_BYTES = 512 * 1024;

// Zerodha appends series suffixes that are not part of the exchange ticker.
// EMPOWER-T, LKPSEC-XT, RAJOOENG-T, TATAGOLD-E ... strip these when resolving.
const SERIES_SUFFIX = /-(T|XT|E|BE|BZ|SM|ST|IT|GB|GS|N\d)$/i;

const stripSeries = (sym) => sym.replace(SERIES_SUFFIX, '');

class BrokerHoldingsService {
  /**
   * @param {object} db      pg Pool
   * @param {object} market  MarketDataService (may be null; degrades gracefully)
   */
  constructor(db, market = null) {
    this.db     = db;
    this.market = market;
  }

  // ── Exchange resolution ───────────────────────────────────────────────────
  // The Zerodha holdings statement has NO exchange column, and getting it wrong
  // means the live-price lookup silently fails for that row. So: try the app's
  // UNIVERSE first, then probe for a real quote, and record which of the two
  // decided — anything still unresolved is surfaced, never buried.
  async _resolveExchange(symbol) {
    const base = stripSeries(symbol).toUpperCase();

    for (const [suffix, exchange] of [['.NS', 'NSE'], ['.BO', 'BSE']]) {
      const meta = UNIVERSE_MAP[`${base}${suffix}`];
      if (meta) {
        return {
          exchange,
          exchangeSource: 'universe',
          yahooSym: `${base}${suffix}`,
          meta,
        };
      }
    }

    if (this.market) {
      for (const [suffix, exchange] of [['.NS', 'NSE'], ['.BO', 'BSE']]) {
        try {
          const q = await this.market.fetchYahooQuote(`${base}${suffix}`);
          if (q && q.ok && q.price) {
            return { exchange, exchangeSource: 'probe', yahooSym: `${base}${suffix}`, meta: null };
          }
        } catch { /* try the next exchange */ }
      }
    }

    // Unresolved. Default to NSE but mark it, so the UI can show "no price" rather
    // than a confidently wrong zero.
    return { exchange: 'NSE', exchangeSource: 'assumed', yahooSym: `${base}.NS`, meta: null };
  }

  // ── Import ────────────────────────────────────────────────────────────────
  /**
   * Import a Zerodha holdings statement (XLSX or CSV).
   *
   * The whole import runs in ONE transaction: either every row lands or none does.
   * A half-imported portfolio is worse than no portfolio, because it looks fine.
   *
   * @param {string} userId
   * @param {Buffer} fileBuffer
   * @param {string} fileName
   */
  async importHoldings(userId, fileBuffer, fileName = 'holdings') {
    const startedAt = Date.now();

    if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
      throw new Error('No file received.');
    }
    if (fileBuffer.length > MAX_FILE_BYTES) {
      throw new Error(
        `File is ${(fileBuffer.length / 1024).toFixed(0)} KB — the limit is ${MAX_FILE_BYTES / 1024} KB.`
      );
    }

    const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // ── Parse ───────────────────────────────────────────────────────────────
    let parsed, rec;
    try {
      // XLSX files are ZIP archives: they begin with "PK".
      const isXlsx = fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4b;
      const rows   = isXlsx ? readXlsx(fileBuffer) : parseCsv(fileBuffer);

      parsed = zerodha.parseHoldings(rows);
      rec    = zerodha.reconcile(parsed);
    } catch (e) {
      await this._audit(userId, {
        operation: 'holdings_import', status: 'failed',
        fileName, checksum, errorMessage: e.message, startedAt,
      });
      throw e;
    }

    // ── Resolve exchanges + enrich from the app's own UNIVERSE ──────────────
    const resolved = [];
    for (const h of parsed.holdings) {
      const r = await this._resolveExchange(h.symbol);
      resolved.push({
        ...h,
        exchange:       r.exchange,
        exchangeSource: r.exchangeSource,
        companyName:    r.meta?.name     || null,
        sector:         r.meta?.sector   || null,   // app taxonomy; broker's kept separately
        industry:       r.meta?.industry || null,
        capCategory:    r.meta?.cap      || null,
      });
    }

    // ── Persist (single transaction) ────────────────────────────────────────
    const client = await this.db.connect();
    let imported = 0;

    try {
      await client.query('BEGIN');

      const seen = [];
      for (const h of resolved) {
        await client.query(
          `INSERT INTO broker_holdings (
             user_id, broker, source, symbol, exchange, exchange_source, isin,
             company_name, broker_sector, sector, industry, cap_category, asset_class,
             quantity, qty_available, qty_long_term, qty_discrepant,
             qty_pledged_margin, qty_pledged_loan,
             avg_buy_price, invested_value,
             stmt_prev_close, stmt_unrealized_pnl, stmt_unrealized_pnl_pct, stmt_as_of,
             is_active, raw_data
           ) VALUES (
             $1,'zerodha','file_import',$2,$3,$4,$5,
             $6,$7,$8,$9,$10,$11,
             $12,$13,$14,$15,
             $16,$17,
             $18,$19,
             $20,$21,$22,$23,
             TRUE,$24
           )
           ON CONFLICT (user_id, broker, symbol, exchange) DO UPDATE SET
             source                 = 'file_import',
             exchange_source        = EXCLUDED.exchange_source,
             isin                   = EXCLUDED.isin,
             company_name           = COALESCE(EXCLUDED.company_name, broker_holdings.company_name),
             broker_sector          = EXCLUDED.broker_sector,
             sector                 = COALESCE(EXCLUDED.sector, broker_holdings.sector),
             industry               = COALESCE(EXCLUDED.industry, broker_holdings.industry),
             cap_category           = COALESCE(EXCLUDED.cap_category, broker_holdings.cap_category),
             asset_class            = EXCLUDED.asset_class,
             quantity               = EXCLUDED.quantity,
             qty_available          = EXCLUDED.qty_available,
             qty_long_term          = EXCLUDED.qty_long_term,
             qty_discrepant         = EXCLUDED.qty_discrepant,
             qty_pledged_margin     = EXCLUDED.qty_pledged_margin,
             qty_pledged_loan       = EXCLUDED.qty_pledged_loan,
             avg_buy_price          = EXCLUDED.avg_buy_price,
             invested_value         = EXCLUDED.invested_value,
             stmt_prev_close        = EXCLUDED.stmt_prev_close,
             stmt_unrealized_pnl    = EXCLUDED.stmt_unrealized_pnl,
             stmt_unrealized_pnl_pct= EXCLUDED.stmt_unrealized_pnl_pct,
             stmt_as_of             = EXCLUDED.stmt_as_of,
             is_active              = TRUE,
             raw_data               = EXCLUDED.raw_data`,
          [
            userId, h.symbol, h.exchange, h.exchangeSource, h.isin,
            h.companyName, h.brokerSector, h.sector, h.industry, h.capCategory, h.assetClass,
            h.quantity, h.qtyAvailable, h.qtyLongTerm, h.qtyDiscrepant,
            h.qtyPledgedMargin, h.qtyPledgedLoan,
            h.avgBuyPrice, h.investedValue,
            h.stmtPrevClose, h.stmtUnrealizedPnl, h.stmtUnrealizedPnlPct, parsed.asOf,
            JSON.stringify(h.rawData),
          ]
        );
        seen.push(`${h.symbol}|${h.exchange}`);
        imported++;
      }

      // Anything previously held but absent from this statement has been fully
      // exited. Mark it inactive rather than deleting it — the history is the
      // point, and a hard delete would destroy it.
      const { rowCount: deactivated } = await client.query(
        `UPDATE broker_holdings
            SET is_active = FALSE
          WHERE user_id = $1
            AND broker = 'zerodha'
            AND is_active = TRUE
            AND (symbol || '|' || exchange) <> ALL($2::text[])`,
        [userId, seen]
      );

      await client.query('COMMIT');

      await this._audit(userId, {
        operation: 'holdings_import',
        status: rec.reconciled ? 'success' : 'partial',
        fileName, checksum, startedAt,
        rowsSeen:     parsed.holdings.length,
        rowsImported: imported,
        rowsSkipped:  parsed.warnings.length,
        reconciled:   rec.reconciled,
        reconcileNote: rec.note,
      });

      return {
        imported,
        deactivated,
        asOf:        parsed.asOf,
        reconciled:  rec.reconciled,
        reconcile:   rec,
        warnings:    parsed.warnings,
        unresolvedExchange: resolved
          .filter(h => h.exchangeSource === 'assumed')
          .map(h => h.symbol),
      };
    } catch (e) {
      await client.query('ROLLBACK');
      await this._audit(userId, {
        operation: 'holdings_import', status: 'failed',
        fileName, checksum, errorMessage: e.message, startedAt,
        rowsSeen: parsed.holdings.length,
      });
      throw e;
    } finally {
      client.release();
    }
  }

  // ── Read ──────────────────────────────────────────────────────────────────
  async getHoldings(userId, { live = false } = {}) {
    const { rows } = await this.db.query(
      `SELECT * FROM broker_holdings
        WHERE user_id = $1 AND is_active = TRUE
        ORDER BY invested_value DESC`,
      [userId]
    );
    if (!rows.length) return { holdings: [], totals: this._emptyTotals(), priceStatus: 'none' };

    let priced = rows;
    if (live && this.market) priced = await this._withLivePrices(rows);

    return this._enrich(priced, live);
  }

  async _withLivePrices(rows) {
    const results = await Promise.allSettled(
      rows.map(r => this.market.fetchYahooQuote(
        `${stripSeries(r.symbol)}${r.exchange === 'BSE' ? '.BO' : '.NS'}`
      ))
    );

    return rows.map((r, i) => {
      const q  = results[i].status === 'fulfilled' ? results[i].value : null;
      const ok = !!(q && q.ok && q.price);
      return {
        ...r,
        last_price:     ok ? q.price     : null,
        day_change_pct: ok ? q.changePct : null,
        price_ok:       ok,
      };
    });
  }

  /**
   * Compute every derived figure. Nothing here is stored.
   *
   * Live P&L is measured against invested_value — the statement's authoritative
   * cost basis — and NOT against quantity * avg_buy_price, which is wrong after a
   * corporate action.
   */
  _enrich(rows, live) {
    const N = (v) => (v === null || v === undefined ? null : Number(v));

    // node-postgres parses a DATE column into a JS Date at LOCAL midnight. Sending
    // that through JSON converts it to UTC, which rolls the date back a day in any
    // timezone east of Greenwich — a statement dated 2026-07-14 arrives in the UI
    // as 2026-07-13. Format from the local components instead.
    const isoDate = (d) => {
      if (!d) return null;
      if (typeof d === 'string') return d.slice(0, 10);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };

    // Fall back to the statement's own close when no live quote is available, so a
    // missing price degrades to "as of the statement" rather than to zero.
    const valued = rows.map(r => {
      const quantity = N(r.quantity);
      const invested = N(r.invested_value);
      const priceOk  = !!r.price_ok;
      const price    = priceOk ? N(r.last_price) : N(r.stmt_prev_close);
      const current  = price !== null ? quantity * price : null;
      const pnl      = current !== null ? current - invested : null;

      return {
        ...r,
        quantity,
        investedValue: invested,
        avgBuyPrice:   N(r.avg_buy_price),
        stmtAsOf:      isoDate(r.stmt_as_of),
        costBasis:     quantity > 0 ? invested / quantity : null,
        price,
        priceOk,
        priceAsOf:     priceOk ? 'live' : 'statement',
        currentValue:  current,
        pnl,
        pnlPct:        (pnl !== null && invested > 0) ? (pnl / invested) * 100 : null,
        dayChangePct:  N(r.day_change_pct),
      };
    });

    const totalInvested = valued.reduce((s, h) => s + (h.investedValue || 0), 0);
    const totalCurrent  = valued.reduce((s, h) => s + (h.currentValue  || 0), 0);

    const holdings = valued.map(h => ({
      ...h,
      weightPct: totalCurrent > 0 && h.currentValue !== null
        ? (h.currentValue / totalCurrent) * 100
        : null,
    }));

    const totalPnl = totalCurrent - totalInvested;
    const stale    = holdings.filter(h => !h.priceOk).length;

    return {
      holdings,
      totals: {
        holdingsCount: holdings.length,
        totalInvested,
        totalCurrent,
        totalPnl,
        totalPnlPct: totalInvested > 0 ? (totalPnl / totalInvested) * 100 : null,
        dayPnl: holdings.reduce(
          (s, h) => s + (h.priceOk && h.dayChangePct !== null && h.currentValue !== null
            ? h.currentValue * (h.dayChangePct / 100) : 0), 0),
      },
      priceStatus: !live ? 'statement' : (stale === 0 ? 'live' : 'partial'),
      stalePrices: holdings.filter(h => !h.priceOk).map(h => h.symbol),
    };
  }

  _emptyTotals() {
    return {
      holdingsCount: 0, totalInvested: 0, totalCurrent: 0,
      totalPnl: 0, totalPnlPct: null, dayPnl: 0,
    };
  }

  async getAudit(userId, limit = 25) {
    const { rows } = await this.db.query(
      `SELECT operation, status, rows_seen, rows_imported, rows_skipped,
              error_message, file_name, reconciled, reconcile_note,
              started_at, duration_ms
         FROM holdings_sync_audit
        WHERE user_id = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [userId, Math.min(limit, 100)]
    );
    return rows;
  }

  /** Purge every holding for this user. Irreversible; audited. */
  async purge(userId) {
    const startedAt = Date.now();
    const { rowCount } = await this.db.query(
      'DELETE FROM broker_holdings WHERE user_id = $1', [userId]
    );
    await this._audit(userId, {
      operation: 'purge', status: 'success', startedAt, rowsImported: rowCount,
    });
    return { deleted: rowCount };
  }

  // ── Audit ─────────────────────────────────────────────────────────────────
  // Counts and metadata ONLY. No payloads, ever — an audit row must never be
  // capable of holding financial or credential data.
  async _audit(userId, a) {
    try {
      await this.db.query(
        `INSERT INTO holdings_sync_audit
           (user_id, operation, status, rows_seen, rows_imported, rows_skipped,
            error_message, file_name, file_checksum, reconciled, reconcile_note,
            finished_at, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12)`,
        [
          userId, a.operation, a.status,
          a.rowsSeen || 0, a.rowsImported || 0, a.rowsSkipped || 0,
          a.errorMessage || null, a.fileName || null, a.checksum || null,
          a.reconciled ?? null, a.reconcileNote || null,
          Date.now() - (a.startedAt || Date.now()),
        ]
      );
    } catch (e) {
      // Never let an audit failure take down the import it is describing.
      console.warn('[Holdings] Audit write failed:', e.message);
    }
  }
}

module.exports = BrokerHoldingsService;
module.exports.stripSeries = stripSeries;
