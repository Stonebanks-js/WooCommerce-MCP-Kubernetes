create table users (
  id uuid primary key,
  email text not null unique,
  name text not null default '',
  role text not null check (role in ('admin','member')),
  status text not null check (status in ('invited','active','disabled')),
  password_hash text,
  invite_token_hash text,
  invite_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index on sessions(user_id);

create table api_keys (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  name text not null default '',
  prefix text not null,
  key_hash text not null unique,
  created_by uuid references users(id),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index on api_keys(prefix);

create table mcp_servers (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  url text not null,
  enabled boolean not null default true,
  auth_type text not null check (auth_type in ('none','bearer','header')),
  auth_header_name text,
  auth_secret_enc text,
  timeout_ms integer not null default 30000,
  member_tool_policy jsonb not null default '{"mode":"all"}',
  status text not null default 'unreachable' check (status in ('connected','unreachable','disabled')),
  status_error text,
  status_checked_at timestamptz,
  tools_json jsonb not null default '[]',
  tools_updated_at timestamptz,
  managed_by text not null default 'admin' check (managed_by in ('admin','seed','provisioner')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  ts timestamptz not null default now(),
  user_id uuid,
  user_email text not null,
  api_key_id uuid,
  source text not null check (source in ('mcp','chat')),
  server_id uuid,
  server_slug text,
  tool_name text,
  public_tool_name text not null,
  duration_ms integer not null,
  outcome text not null check (outcome in ('success','error','timeout','unreachable','denied','not_found','rate_limited')),
  error_message text,
  args_preview text,
  result_bytes integer
);
create index on audit_log(ts desc);
create index on audit_log(user_id, ts desc);
