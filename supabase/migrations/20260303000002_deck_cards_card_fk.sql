-- Add referential integrity for non-null card_id values.
-- ON DELETE SET NULL so card deletions don't cascade and remove deck data.
alter table deck_cards
  add constraint fk_deck_cards_card
  foreign key (card_id) references cards(id)
  on delete set null;
