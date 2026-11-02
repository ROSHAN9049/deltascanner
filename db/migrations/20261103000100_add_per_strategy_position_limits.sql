BEGIN;

ALTER TABLE public.dd_settings
  ADD COLUMN IF NOT EXISTS max_momentum_positions INTEGER NOT NULL DEFAULT 5
    CHECK (max_momentum_positions BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS max_scalping_positions INTEGER NOT NULL DEFAULT 5
    CHECK (max_scalping_positions BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS max_grid_positions INTEGER NOT NULL DEFAULT 2
    CHECK (max_grid_positions BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS max_options_positions INTEGER NOT NULL DEFAULT 4
    CHECK (max_options_positions BETWEEN 1 AND 20);

UPDATE public.dd_settings
SET
  max_momentum_positions = COALESCE(max_momentum_positions, 5),
  max_scalping_positions = COALESCE(max_scalping_positions, 5),
  max_grid_positions = COALESCE(max_grid_positions, 2),
  max_options_positions = COALESCE(max_options_positions, 4)
WHERE id = 1;

NOTIFY pgrst, 'reload schema';
COMMIT;
