-- pgvector similarity search for article chunk retrieval
create or replace function match_article_chunks(
  query_embedding vector(1024),
  format_filter   text default null,
  match_count     int default 20
)
returns table (
  chunk_id       uuid,
  article_id     uuid,
  chunk_index    int,
  content        text,
  archetypes     text[],
  cards_mentioned text[],
  title          text,
  author         text,
  published_at   timestamptz,
  source         text,
  similarity     float
)
language plpgsql
as $$
begin
  return query
  select
    ac.id          as chunk_id,
    ac.article_id,
    ac.chunk_index,
    ac.content,
    ac.archetypes,
    ac.cards_mentioned,
    a.title,
    a.author,
    a.published_at,
    a.source,
    1 - (ac.embedding <=> query_embedding) as similarity
  from article_chunks ac
  join articles a on a.id = ac.article_id
  where ac.embedding is not null
    and (format_filter is null or a.format is null or a.format = format_filter)
  order by ac.embedding <=> query_embedding
  limit match_count;
end;
$$;
