create or replace function hisaab_on_write() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;  -- older offline edit arriving late: keep the newer row
  end if;
  new.server_updated_at := clock_timestamp();
  return new;
end $$;

create table trips (
  id uuid primary key, name text not null, currency text not null default 'PKR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted boolean not null default false,
  server_updated_at timestamptz not null default clock_timestamp()
);
create table members (
  id uuid primary key, trip_id uuid not null references trips(id), name text not null,
  updated_at timestamptz not null default now(), deleted boolean not null default false,
  server_updated_at timestamptz not null default clock_timestamp()
);
create table expenses (
  id uuid primary key, trip_id uuid not null references trips(id), title text not null,
  amount_minor bigint not null check (amount_minor > 0), paid_by uuid not null references members(id),
  spent_at timestamptz not null default now(), notes text not null default '',
  shares jsonb not null default '[]',
  updated_at timestamptz not null default now(), deleted boolean not null default false,
  server_updated_at timestamptz not null default clock_timestamp()
);
create table settlements (
  id uuid primary key, trip_id uuid not null references trips(id),
  from_member uuid not null references members(id), to_member uuid not null references members(id),
  amount_minor bigint not null check (amount_minor > 0), paid_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted boolean not null default false,
  server_updated_at timestamptz not null default clock_timestamp()
);

create trigger trips_on_write before insert or update on trips for each row execute function hisaab_on_write();
create trigger members_on_write before insert or update on members for each row execute function hisaab_on_write();
create trigger expenses_on_write before insert or update on expenses for each row execute function hisaab_on_write();
create trigger settlements_on_write before insert or update on settlements for each row execute function hisaab_on_write();

create index on trips (server_updated_at);
create index on members (server_updated_at);
create index on expenses (server_updated_at);
create index on settlements (server_updated_at);

alter table trips enable row level security;
alter table members enable row level security;
alter table expenses enable row level security;
alter table settlements enable row level security;
create policy "friends can do everything" on trips for all to authenticated using (true) with check (true);
create policy "friends can do everything" on members for all to authenticated using (true) with check (true);
create policy "friends can do everything" on expenses for all to authenticated using (true) with check (true);
create policy "friends can do everything" on settlements for all to authenticated using (true) with check (true);

create view balances with (security_invoker = true) as
with ledger as (
  select paid_by as member_id, amount_minor as amt from expenses where not deleted
  union all
  select (s->>'member_id')::uuid, -(s->>'amount_minor')::bigint
  from expenses e, jsonb_array_elements(e.shares) s where not e.deleted
  union all
  select from_member, amount_minor from settlements where not deleted
  union all
  select to_member, -amount_minor from settlements where not deleted
)
select t.name as trip, m.name as member, round(coalesce(sum(l.amt), 0) / 100.0, 2) as balance
from members m join trips t on t.id = m.trip_id and not t.deleted
left join ledger l on l.member_id = m.id
group by t.name, m.id, m.name
order by t.name, balance desc;
