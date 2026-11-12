CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL CHECK (role IN ('client','merchant','courier','admin')),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text NOT NULL,
  phone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  default_address jsonb,
  geo_consent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  category text NOT NULL,
  description text NOT NULL DEFAULT '',
  emoji text NOT NULL DEFAULT '🍽️',
  cover_url text,
  address text NOT NULL,
  location geography(Point,4326) NOT NULL,
  phone text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended')),
  is_online boolean NOT NULL DEFAULT true,
  opening_hours jsonb NOT NULL DEFAULT '{}',
  commission_rate numeric,
  prep_minutes int NOT NULL DEFAULT 15,
  is_demo boolean NOT NULL DEFAULT false,
  stripe_account_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merchants_location_idx ON merchants USING gist(location);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'Carte',
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_cents int NOT NULL CHECK (price_cents >= 0),
  image_url text,
  emoji text NOT NULL DEFAULT '🍽️',
  available boolean NOT NULL DEFAULT true,
  stock int,
  options jsonb NOT NULL DEFAULT '[]',
  position int NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_merchant_idx ON products(merchant_id);

CREATE TABLE couriers (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  vehicle text NOT NULL CHECK (vehicle IN ('bike','ebike','scooter','car')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','suspended')),
  available boolean NOT NULL DEFAULT false,
  location geography(Point,4326),
  location_updated_at timestamptz,
  total_km numeric NOT NULL DEFAULT 0,
  stripe_account_id text
);
CREATE INDEX couriers_location_idx ON couriers USING gist(location);

CREATE SEQUENCE order_number_seq START 1001;
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number int NOT NULL DEFAULT nextval('order_number_seq'),
  client_id uuid NOT NULL REFERENCES users(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  courier_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN (
    'awaiting_payment','placed','accepted','preparing','courier_assigned',
    'courier_en_route','picked_up','delivering','delivered','cancelled')),
  instructions text NOT NULL DEFAULT '',
  address text NOT NULL,
  address_details text NOT NULL DEFAULT '',
  location geography(Point,4326) NOT NULL,
  distance_m int NOT NULL,
  subtotal_cents int NOT NULL,
  delivery_fee_cents int NOT NULL,
  total_cents int NOT NULL,
  commission_cents int NOT NULL,
  courier_pay_cents int NOT NULL DEFAULT 0,
  prep_minutes int,
  ready_at timestamptz,
  delivery_code text NOT NULL,
  proof_url text,
  payment_method text NOT NULL DEFAULT 'card',
  payment_provider text NOT NULL,
  payment_ref text,
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed','refunded','partially_refunded')),
  refunded_cents int NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  merchant_rating int CHECK (merchant_rating BETWEEN 1 AND 5),
  merchant_comment text,
  courier_rating int CHECK (courier_rating BETWEEN 1 AND 5),
  cancel_reason text,
  cancelled_by text,
  courier_km numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (client_id, idempotency_key)
);
CREATE INDEX orders_client_idx ON orders(client_id, created_at DESC);
CREATE INDEX orders_merchant_idx ON orders(merchant_id, created_at DESC);
CREATE INDEX orders_courier_idx ON orders(courier_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders(status);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id),
  name text NOT NULL,
  unit_price_cents int NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  options jsonb NOT NULL DEFAULT '[]',
  note text NOT NULL DEFAULT ''
);
CREATE INDEX order_items_order_idx ON order_items(order_id);

CREATE TABLE order_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status text NOT NULL,
  actor_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events(order_id);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  courier_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','refused','expired','cancelled')),
  pay_cents int NOT NULL,
  pickup_distance_m int NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Garanties de cohérence : une seule proposition active par commande et par livreur
CREATE UNIQUE INDEX offers_one_pending_per_order ON offers(order_id) WHERE status = 'pending';
CREATE UNIQUE INDEX offers_one_pending_per_courier ON offers(courier_id) WHERE status = 'pending';

CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES orders(id),
  type text NOT NULL CHECK (type IN ('payment','refund','merchant_payout','courier_payout')),
  amount_cents int NOT NULL,
  beneficiary_id uuid,
  provider text NOT NULL,
  provider_ref text,
  status text NOT NULL DEFAULT 'succeeded',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transactions_order_idx ON transactions(order_id);

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES users(id),
  order_id uuid REFERENCES orders(id),
  category text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text,
  refund_cents int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE messages (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  thread text NOT NULL CHECK (thread IN ('courier','merchant')),
  sender_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_order_idx ON messages(order_id, thread);

CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);

CREATE TABLE devices (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL DEFAULT 'web',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
INSERT INTO settings(key, value) VALUES
  ('delivery_fee', '{"base_cents":199,"per_km_cents":60,"min_cents":199,"max_cents":799}'),
  ('commission',   '{"rate":0.25}'),
  ('courier_pay',  '{"base_cents":250,"per_km_cents":90,"approach_per_km_cents":30,"min_cents":350}'),
  ('dispatch',     '{"radius_km":5,"offer_timeout_s":30}'),
  ('service',      '{"max_delivery_km":8,"enforce_hours":false,"min_order_cents":500,"accept_timeout_min":10}');
