// ── Transaction Service — Phase 3 / Phase 4 ──────────────────────────────────
// Handles BUY and SELL operations using the Average Cost Method.
// All writes (position update + trade_history insert) run inside a single
// PostgreSQL transaction — no partial writes possible.
//
// Average Cost Method:
//   BUY into existing position:
//     new_avg = ((old_qty × old_avg) + (new_qty × new_price)) / (old_qty + new_qty)
//
//   SELL (partial or full):
//     realized_pnl = (sell_price − avg_buy_price) × qty_sold
//     avg_buy_price does NOT change for remaining shares
//
// Phase 4: cap_category stored at buy time from UNIVERSE_MAP

const { UNIVERSE_MAP } = require('./universe');

function resolveCap(symbol, exchange) {
  const suffix = (exchange || 'NSE').toUpperCase() === 'BSE' ? '.BO' : '.NS';
  return UNIVERSE_MAP[`${symbol.toUpperCase()}${suffix}`]?.cap || null;
}

class TransactionService {
  constructor(db) {
    this.db = db;
  }

  // ── BUY ───────────────────────────────────────────────────────────────────
  // Creates a new position OR averages into an existing open/partial position.
  // Returns the updated/created position row + the trade_history row.
  async buy(userId, data) {
    const {
      symbol,
      exchange      = 'NSE',
      company_name  = null,
      sector        = null,
      industry      = null,
      quantity,
      price,
      buy_date      = new Date().toISOString().slice(0, 10),
      stop_loss     = null,
      target        = null,
      notes         = null,
    } = data;

    if (!symbol || !quantity || !price) {
      throw new Error('symbol, quantity, and price are required');
    }
    if (Number(quantity) <= 0) throw new Error('quantity must be greater than 0');
    if (Number(price) <= 0)    throw new Error('price must be greater than 0');

    const sym  = symbol.toUpperCase();
    const exch = (exchange || 'NSE').toUpperCase();
    const qty  = Number(quantity);
    const px   = Number(price);

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Check for existing open/partial position on this symbol
      const existing = await client.query(
        `SELECT id, quantity, average_buy_price, status
           FROM positions
          WHERE user_id = $1
            AND symbol  = $2
            AND exchange = $3
            AND status IN ('open','partial')
          LIMIT 1`,
        [userId, sym, exch]
      );

      let position;
      let transactionType = 'BUY';

      if (existing.rows.length > 0) {
        // ── Average into existing position ──────────────────────────────────
        const pos     = existing.rows[0];
        const oldQty  = Number(pos.quantity);
        const oldAvg  = Number(pos.average_buy_price);
        const newQty  = oldQty + qty;
        const newAvg  = ((oldQty * oldAvg) + (qty * px)) / newQty;

        const updated = await client.query(
          `UPDATE positions
              SET quantity          = $1,
                  average_buy_price = $2,
                  status            = 'open',
                  stop_loss         = COALESCE($3, stop_loss),
                  target            = COALESCE($4, target)
            WHERE id = $5
            RETURNING *`,
          [newQty, newAvg, stop_loss, target, pos.id]
        );
        position = updated.rows[0];
      } else {
        // ── Create new position ─────────────────────────────────────────────
        const cap_category = data.cap_category || resolveCap(sym, exch);
        const inserted = await client.query(
          `INSERT INTO positions
             (user_id, symbol, exchange, company_name, sector, industry,
              cap_category, quantity, average_buy_price, buy_date, stop_loss, target, notes, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open')
           RETURNING *`,
          [userId, sym, exch, company_name, sector, industry,
           cap_category, qty, px, buy_date, stop_loss, target, notes]
        );
        position = inserted.rows[0];
      }

      // ── Record trade history ────────────────────────────────────────────
      const tradeRow = await client.query(
        `INSERT INTO trade_history
           (user_id, position_id, symbol, exchange, company_name,
            action, transaction_type, quantity, price, total_value,
            notes, executed_at)
         VALUES ($1,$2,$3,$4,$5,'BUY',$6,$7,$8,$9,$10,NOW())
         RETURNING *`,
        [userId, position.id, sym, exch, company_name,
         transactionType, qty, px, qty * px, notes]
      );

      await client.query('COMMIT');
      return { position, trade: tradeRow.rows[0] };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ── SELL ──────────────────────────────────────────────────────────────────
  // Partial or full exit using Average Cost Method.
  // realized_pnl = (sell_price − avg_buy_price) × qty_sold
  // avg_buy_price does NOT change for remaining shares.
  async sell(userId, data) {
    const {
      position_id,
      quantity,
      price,
      notes = null,
    } = data;

    if (!position_id || !quantity || !price) {
      throw new Error('position_id, quantity, and price are required');
    }
    if (Number(quantity) <= 0) throw new Error('quantity must be greater than 0');
    if (Number(price) <= 0)    throw new Error('price must be greater than 0');

    const qty = Number(quantity);
    const px  = Number(price);

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Lock the position row for update
      const posResult = await client.query(
        `SELECT * FROM positions
          WHERE id = $1 AND user_id = $2
            AND status IN ('open','partial')
          FOR UPDATE`,
        [position_id, userId]
      );

      if (posResult.rows.length === 0) {
        throw new Error('Position not found, already closed, or not owned by user');
      }

      const pos        = posResult.rows[0];
      const currentQty = Number(pos.quantity);
      const avgCost    = Number(pos.average_buy_price);

      if (qty > currentQty) {
        throw new Error(
          `Cannot sell ${qty} — only ${currentQty} shares held`
        );
      }

      // ── Average Cost Method: realized P&L ──────────────────────────────
      const realizedPnl    = (px - avgCost) * qty;
      const holdingDays    = Math.floor(
        (Date.now() - new Date(pos.buy_date).getTime()) / 86400000
      );
      const remainingQty   = currentQty - qty;
      const isFull         = remainingQty === 0;
      const transactionType = isFull ? 'SELL' : 'PARTIAL_SELL';

      // ── Update position ────────────────────────────────────────────────
      let updatedPos;
      if (isFull) {
        // Full exit — calculate weighted average exit price
        // Fetch previous sell trades to compute weighted avg exit
        const prevSells = await client.query(
          `SELECT quantity, price FROM trade_history
            WHERE position_id = $1
              AND transaction_type IN ('SELL','PARTIAL_SELL')`,
          [position_id]
        );
        let totalSoldQty   = qty;
        let totalSoldValue = qty * px;
        for (const row of prevSells.rows) {
          totalSoldQty   += Number(row.quantity);
          totalSoldValue += Number(row.quantity) * Number(row.price);
        }
        const weightedExitPrice = totalSoldValue / totalSoldQty;

        const res = await client.query(
          `UPDATE positions
              SET quantity     = 0,
                  status       = 'closed',
                  realized_pnl = realized_pnl + $1,
                  closed_at    = NOW(),
                  exit_price   = $2
            WHERE id = $3
            RETURNING *`,
          [realizedPnl, weightedExitPrice, position_id]
        );
        updatedPos = res.rows[0];
      } else {
        // Partial exit — avg_buy_price unchanged
        const res = await client.query(
          `UPDATE positions
              SET quantity     = $1,
                  status       = 'partial',
                  realized_pnl = realized_pnl + $2
            WHERE id = $3
            RETURNING *`,
          [remainingQty, realizedPnl, position_id]
        );
        updatedPos = res.rows[0];
      }

      // ── Record trade history ────────────────────────────────────────────
      const pnlPct = (realizedPnl / (avgCost * qty)) * 100;

      const tradeRow = await client.query(
        `INSERT INTO trade_history
           (user_id, position_id, symbol, exchange, company_name,
            action, transaction_type, quantity, price, total_value,
            pnl, pnl_pct, holding_days, notes, executed_at)
         VALUES ($1,$2,$3,$4,$5,
                 $6,$7,$8,$9,$10,
                 $11,$12,$13,$14,NOW())
         RETURNING *`,
        [
          userId, position_id,
          pos.symbol, pos.exchange, pos.company_name,
          transactionType === 'SELL' ? 'SELL' : 'PARTIAL',
          transactionType,
          qty, px, qty * px,
          realizedPnl, pnlPct, holdingDays,
          notes,
        ]
      );

      await client.query('COMMIT');
      return { position: updatedPos, trade: tradeRow.rows[0] };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

module.exports = TransactionService;
