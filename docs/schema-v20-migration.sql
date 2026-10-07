-- Stores the shared customer pre-order notice and its optimistic version.

BEGIN IMMEDIATE;

CREATE TABLE customer_order_start_notice_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  heading_text TEXT NOT NULL CHECK (length(trim(heading_text)) BETWEEN 1 AND 120),
  body_text TEXT NOT NULL CHECK (length(trim(body_text)) BETWEEN 1 AND 4000),
  version INTEGER NOT NULL CHECK (version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

INSERT INTO customer_order_start_notice_settings (
  singleton_id, heading_text, body_text, version, created_at_ms, updated_at_ms
) VALUES (
  1,
  'ご注文の前にご確認ください',
  '20歳未満の入店禁止' || char(10)
    || '飲酒運転しません・させません' || char(10)
    || 'SNS投稿・LIVE配信禁止' || char(10)
    || 'お支払いは現金のみ',
  0,
  0,
  0
);

PRAGMA user_version = 20;
COMMIT;
