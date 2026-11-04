-- Structure signature of the `public` schema: one line per column (type, NOT NULL, default), per constraint (primary key, foreign key, unique, check) and per index.
-- READ-ONLY: it only reads Postgres catalogs. No row of any table is read, so it returns no personal data.
-- Returns one cell, `signature`. Copy the whole cell into a text file and compare it with the expected structure:
--     node scripts/schema-signature.js --compare <that file>
select string_agg(line, E'\n' order by line) as signature
from (
  select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || case when a.attnotnull then ' NOT NULL' else '' end
         || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') as line
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  union all
  select 'con ' || c.relname || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid)
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
  union all
  select 'idx ' || tablename || ' ' || indexdef
  from pg_indexes
  where schemaname = 'public'
) s;
