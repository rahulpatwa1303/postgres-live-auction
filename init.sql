CREATE TABLE IF NOT EXISTS items (
    id SERIAL PRIMARY KEY,
    name TEXT,
    description TEXT,
    image_url TEXT,
    current_price DECIMAL DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    ends_at TIMESTAMP DEFAULT NOW() + INTERVAL '10 minutes'
);

CREATE TABLE IF NOT EXISTS bids (
    id SERIAL PRIMARY KEY,
    item_id INTEGER REFERENCES items(id),
    bidder_name TEXT,
    amount DECIMAL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ── Trigger: new bid placed ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_new_bid()
RETURNS trigger AS $$
BEGIN
  UPDATE items SET current_price = NEW.amount WHERE id = NEW.item_id;
  PERFORM pg_notify('auction_update', json_build_object(
    'type',      'NEW_BID',
    'item_id',   NEW.item_id,
    'bidder',    NEW.bidder_name,
    'new_price', NEW.amount,
    'time',      NEW.created_at
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_bid_placed ON bids;
CREATE TRIGGER on_bid_placed
AFTER INSERT ON bids
FOR EACH ROW EXECUTE FUNCTION handle_new_bid();

-- ── Trigger: item inserted or discontinued ───────────────────────────────────
CREATE OR REPLACE FUNCTION handle_item_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('auction_update', json_build_object(
      'type', 'NEW_ITEM',
      'item', row_to_json(NEW)
    )::text);

  ELSIF TG_OP = 'UPDATE'
    AND NEW.status = 'discontinued'
    AND OLD.status = 'active'
  THEN
    PERFORM pg_notify('auction_update', json_build_object(
      'type',    'AUCTION_DISCONTINUED',
      'item_id', NEW.id,
      'name',    NEW.name
    )::text);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_item_change ON items;
CREATE TRIGGER on_item_change
AFTER INSERT OR UPDATE ON items
FOR EACH ROW EXECUTE FUNCTION handle_item_change();

-- ── Seed ─────────────────────────────────────────────────────────────────────
INSERT INTO items (name, description, image_url, current_price)
VALUES
  ('Cyberpunk Watch v1.0',
   'Limited edition neon-infused timepiece from the year 2077.',
   'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&q=80&w=800',
   250),
  ('Vintage Camera — Leica M3',
   'Fully functional 1954 rangefinder in near-mint condition.',
   'https://images.unsplash.com/photo-1495121553079-4c61bcce1894?auto=format&fit=crop&q=80&w=800',
   800),
  ('Rare Vinyl Collection',
   '12 original pressings from the golden age of jazz, 1955-1962.',
   'https://images.unsplash.com/photo-1593078166039-c9878df5c520?auto=format&fit=crop&q=80&w=800',
   120);
