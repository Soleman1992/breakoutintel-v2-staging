// ── Portfolio Service — Phase 1 ───────────────────────────────────────────────
// CRUD operations for the positions table.
// Fields: symbol, exchange, quantity, average_buy_price, buy_date,
//         stop_loss, target, notes
// No P&L, no analytics — those belong to later phases.

class PortfolioService {
  constructor(db) {
    this.db = db;
  }

  // ── GET all positions ──────────────────────────────────────────────────────
  async getPositions(userId) {
    const { rows } = await this.db.query(
      `SELECT id, symbol, exchange, quantity, average_buy_price,
              buy_date, stop_loss, target, notes, status,
              created_at, updated_at
         FROM positions
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId]
    );
    return rows;
  }

  // ── POST — add a position ──────────────────────────────────────────────────
  async addPosition(userId, data) {
    const {
      symbol,
      exchange = 'NSE',
      quantity,
      average_buy_price,
      buy_date,
      stop_loss = null,
      target = null,
      notes = null,
    } = data;

    if (!symbol || !quantity || !average_buy_price) {
      throw new Error('symbol, quantity, and average_buy_price are required');
    }

    const { rows } = await this.db.query(
      `INSERT INTO positions
         (user_id, symbol, exchange, quantity, average_buy_price,
          buy_date, stop_loss, target, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, symbol, exchange, quantity, average_buy_price,
                 buy_date, stop_loss, target, notes, status,
                 created_at, updated_at`,
      [
        userId,
        symbol.toUpperCase(),
        exchange.toUpperCase(),
        quantity,
        average_buy_price,
        buy_date || new Date().toISOString().slice(0, 10),
        stop_loss,
        target,
        notes,
      ]
    );
    return rows[0];
  }

  // ── PUT — update a position ────────────────────────────────────────────────
  async updatePosition(userId, positionId, data) {
    // Only allow updating these fields
    const allowed = [
      'symbol', 'exchange', 'quantity', 'average_buy_price',
      'buy_date', 'stop_loss', 'target', 'notes', 'status',
    ];

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const key of allowed) {
      if (data[key] !== undefined) {
        setClauses.push(`${key} = $${idx}`);
        values.push(
          (key === 'symbol' || key === 'exchange') && typeof data[key] === 'string'
            ? data[key].toUpperCase()
            : data[key]
        );
        idx++;
      }
    }

    if (setClauses.length === 0) {
      throw new Error('No valid fields provided for update');
    }

    values.push(positionId, userId);

    const { rows } = await this.db.query(
      `UPDATE positions
          SET ${setClauses.join(', ')}
        WHERE id = $${idx} AND user_id = $${idx + 1}
        RETURNING id, symbol, exchange, quantity, average_buy_price,
                  buy_date, stop_loss, target, notes, status,
                  created_at, updated_at`,
      values
    );

    if (rows.length === 0) {
      throw new Error('Position not found or not owned by user');
    }
    return rows[0];
  }

  // ── DELETE — remove a position ─────────────────────────────────────────────
  async deletePosition(userId, positionId) {
    const { rowCount } = await this.db.query(
      `DELETE FROM positions
        WHERE id = $1 AND user_id = $2`,
      [positionId, userId]
    );

    if (rowCount === 0) {
      throw new Error('Position not found or not owned by user');
    }
    return { deleted: true, id: positionId };
  }
}

module.exports = PortfolioService;
