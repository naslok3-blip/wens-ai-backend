PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'محادثة جديدة',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

ALTER TABLE messages
  ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;

-- Preserve every existing message by moving each user's old single transcript
-- into one clearly named legacy conversation. No message content is changed.
INSERT INTO conversations (id, user_id, title, created_at, updated_at)
SELECT
  'legacy-' || lower(hex(randomblob(12))),
  user_id,
  'المحادثات السابقة',
  COALESCE(MIN(created_at), CAST(strftime('%s','now') AS INTEGER)),
  COALESCE(MAX(created_at), CAST(strftime('%s','now') AS INTEGER))
FROM messages
GROUP BY user_id;

UPDATE messages
SET conversation_id = (
  SELECT conversations.id
  FROM conversations
  WHERE conversations.user_id = messages.user_id
    AND conversations.title = 'المحادثات السابقة'
  ORDER BY conversations.created_at ASC
  LIMIT 1
)
WHERE conversation_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
  ON conversations(user_id, archived_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages(conversation_id, created_at ASC);
