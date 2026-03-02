-- Atomic deck_cards sync: delete existing rows and insert fresh ones in a
-- single transaction. Replaces the non-atomic delete+insert pattern in parsers.
create or replace function sync_deck_cards(
  p_deck_id text,
  p_rows    jsonb
)
returns void
language plpgsql
as $$
begin
  delete from deck_cards where deck_id = p_deck_id;

  insert into deck_cards (deck_id, card_name, card_id, quantity, is_sideboard)
  select
    p_deck_id,
    row->>'card_name',
    row->>'card_id',
    (row->>'quantity')::int,
    (row->>'is_sideboard')::boolean
  from jsonb_array_elements(p_rows) as row;
end;
$$;
