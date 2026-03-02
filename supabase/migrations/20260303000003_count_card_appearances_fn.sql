-- Count how many qualifying decks include a given card.
-- Replaces the three-step unbounded .in() chain in the retrieval layer.
create or replace function count_card_appearances(
  p_card_name   text,
  p_format      text,
  p_cutoff      date,
  p_max_placement int default 32
)
returns bigint
language sql
stable
as $$
  select count(distinct dc.deck_id)
  from deck_cards dc
  join decks d on d.id = dc.deck_id
  join tournaments t on t.id = d.tournament_id
  where dc.card_name = p_card_name
    and d.placement is not null
    and d.placement <= p_max_placement
    and t.date >= p_cutoff
    and (p_format is null or t.format = p_format);
$$;
