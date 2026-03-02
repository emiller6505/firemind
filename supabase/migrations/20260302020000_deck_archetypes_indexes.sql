-- deck_archetypes is queried by method (snapshot worker, cluster worker)
-- and by archetype_id (retrieval layer archetype lookup).
-- The PK (deck_id, archetype_id) only covers deck_id-first lookups.

create index idx_deck_archetypes_method    on deck_archetypes (method);
create index idx_deck_archetypes_archetype on deck_archetypes (archetype_id);
