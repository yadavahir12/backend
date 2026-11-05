ALTER TABLE game_rounds
  ADD COLUMN IF NOT EXISTS result_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS game_rounds_status_end_idx
  ON game_rounds(status, end_time);

CREATE INDEX IF NOT EXISTS game_rounds_number_idx
  ON game_rounds(round_number DESC);

CREATE OR REPLACE FUNCTION prevent_finalized_game_result_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.result IS NOT NULL AND (
    NEW.result IS DISTINCT FROM OLD.result
    OR NEW.result_generated_at IS DISTINCT FROM OLD.result_generated_at
  ) THEN
    RAISE EXCEPTION 'FINALIZED_GAME_RESULT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS game_round_result_immutable ON game_rounds;
CREATE TRIGGER game_round_result_immutable
  BEFORE UPDATE ON game_rounds
  FOR EACH ROW EXECUTE FUNCTION prevent_finalized_game_result_update();
