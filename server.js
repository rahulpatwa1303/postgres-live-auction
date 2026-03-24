require('dotenv').config();

const express = require('express');
const { Client, Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Query pool (shared connections for normal queries) ────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Postgres connection ──────────────────────────────────────────────────────
// Use a dedicated client for LISTEN — it must stay alive for the lifetime
// of the process. Neon (and any serverless PG) can drop idle connections,
// so we reconnect automatically on error or unexpected close.

let pgClient;

async function connectDB() {
  pgClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
  });

  try {
    await pgClient.connect();
    await new Promise(r => setTimeout(r, 0)); // flush connect completion
    await pgClient.query('LISTEN auction_update');
    console.log('✓ Connected to PostgreSQL, listening on auction_update');

    // Postgres triggers → broadcast to every connected browser
    pgClient.on('notification', (msg) => {
      try {
        io.emit('update', JSON.parse(msg.payload));
      } catch (e) {
        console.error('Bad notification payload:', e.message);
      }
    });

    pgClient.on('error', (err) => {
      console.error('PG client error:', err.message);
      scheduleReconnect();
    });

    pgClient.on('end', () => {
      console.warn('PG connection closed — will reconnect');
      scheduleReconnect();
    });

  } catch (err) {
    console.error('Failed to connect to PostgreSQL:', err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect(delay = 3000) {
  setTimeout(async () => {
    try { await pgClient?.end(); } catch {}
    connectDB();
  }, delay);
}

connectDB();

// ── Auction Master Loop ──────────────────────────────────────────────────────
// Closes auctions whose time has expired. Runs every second.
// In production you'd replace this with a pg_cron job.
setInterval(async () => {
  try {
    const res = await pool.query(
      "UPDATE items SET status = 'closed' WHERE ends_at <= NOW() AND status = 'active' RETURNING *"
    );
    res.rows.forEach(item => {
      console.log(`Auction closed: ${item.name}`);
      io.emit('update', {
        type:    'AUCTION_CLOSED',
        item_id: item.id,
        name:    item.name,
        price:   item.current_price,
      });
    });
  } catch (err) {
    // pgClient may be reconnecting — skip this tick
  }
}, 1000);

// ── Socket handlers ──────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
  try {
    const res = await pool.query(`
      SELECT i.*,
        (SELECT bidder_name FROM bids WHERE item_id = i.id ORDER BY created_at DESC LIMIT 1) AS last_bidder,
        (SELECT COUNT(*) FROM bids WHERE item_id = i.id) AS bid_count
      FROM items i ORDER BY i.id ASC
    `);
    socket.emit('init_items', res.rows);
  } catch (err) {
    console.error('init_items error:', err.message);
  }

  // Place a bid
  socket.on('place_bid', async (bid) => {
    try {
      const item = await pool.query(
        'SELECT status, current_price FROM items WHERE id = $1', [bid.item_id]
      );
      if (item.rows[0]?.status === 'active' && bid.amount > item.rows[0].current_price) {
        await pool.query(
          'INSERT INTO bids (item_id, bidder_name, amount) VALUES ($1, $2, $3)',
          [bid.item_id, bid.name, bid.amount]
        );
        // → trigger fires pg_notify NEW_BID → fan-out via notification handler
      } else {
        socket.emit('bid_rejected', {
          item_id: bid.item_id,
          reason: item.rows[0]?.status !== 'active' ? 'Auction has ended' : 'Bid must exceed current price',
        });
      }
    } catch (err) {
      console.error('place_bid error:', err.message);
      socket.emit('bid_rejected', { item_id: bid.item_id, reason: 'Server error, please try again' });
    }
  });

  // Add a new auction item
  socket.on('add_item', async (item) => {
    try {
      const duration = Math.max(1, Math.min(1440, parseInt(item.duration) || 10));
      await pool.query(
        `INSERT INTO items (name, description, image_url, current_price, ends_at)
         VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)`,
        [
          item.name,
          item.description   || '',
          item.image_url     || '',
          parseFloat(item.starting_price) || 0,
          duration,
        ]
      );
      // → trigger fires pg_notify NEW_ITEM → fan-out via notification handler
      console.log(`New item listed: ${item.name}`);
    } catch (err) {
      console.error('add_item error:', err.message);
    }
  });

  // Discontinue an active auction (ends with no winner)
  socket.on('discontinue_item', async ({ item_id }) => {
    try {
      await pool.query(
        "UPDATE items SET status = 'discontinued' WHERE id = $1 AND status = 'active'",
        [item_id]
      );
      // → trigger fires pg_notify AUCTION_DISCONTINUED → fan-out via notification handler
      console.log(`Item ${item_id} discontinued`);
    } catch (err) {
      console.error('discontinue_item error:', err.message);
    }
  });
});

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`AuctionHouse running on http://localhost:${PORT}`));
