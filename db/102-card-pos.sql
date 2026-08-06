-- 102 — ordering is MODEL DATA (the worked pattern). ui.ts renders arrival
-- order and always has; position belongs to the row, like any other field.
-- A card gets `pos`: composed into the doc by card_json, moved by ordinary
-- replace ops on /cards/<id>/pos, rendered by the client as flex `order`
-- (see index.ts). A MOVE is a SWAP — two pos replaces in ONE batch, atomic
-- in one transaction, both echoed, both undone together. Positions stay
-- integers (CSS `order` takes nothing else); the column is double precision
-- so an app that outgrows swap (drag-drop wants midpoints) can graduate to
-- fractional positions without another migration.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS pos double precision;
UPDATE cards SET pos = id WHERE pos IS NULL;   -- backfill preserves arrival order
