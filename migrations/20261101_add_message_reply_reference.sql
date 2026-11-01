ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS messages_id_group_idx ON messages(id, group_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'messages_reply_to_message_id_fkey'
      AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_reply_to_message_id_fkey
      FOREIGN KEY (reply_to_message_id)
      REFERENCES messages(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'messages_reply_same_group_fk'
      AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_reply_same_group_fk
      FOREIGN KEY (reply_to_message_id, group_id)
      REFERENCES messages(id, group_id);
  END IF;
END;
$$;
