-- ═══════════════════════════════════════════════════════════════
--  ORİMAK Takip — Asistan (Notlar + Telefon Bildirimi) veritabanı kurulumu
--  Supabase → SQL Editor'a yapıştırıp bir kez "Run" deyin.
--  Tekrar çalıştırmak zararsızdır; mevcut hiçbir tabloya dokunmaz.
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.st_ayar (
  anahtar text primary key,
  deger   jsonb not null,
  guncel  timestamptz not null default now()
);

create table if not exists public.st_oturum (
  token      text primary key,
  kullanici  text not null,
  tur        text not null default 'site',     -- 'site' | 'kisayol'
  olusturma  timestamptz not null default now()
);

create table if not exists public.st_notlar (
  id           bigint generated always as identity primary key,
  yazan        text not null,
  metin        text not null,
  alicilar     jsonb not null default '[]'::jsonb,
  hatirlat_at  timestamptz,
  hatirlatildi boolean not null default false,
  tamam        boolean not null default false,
  kaynak       text not null default 'site',
  olusturma    timestamptz not null default now()
);
create index if not exists st_notlar_hatirlat_idx on public.st_notlar (hatirlat_at) where hatirlatildi = false;

create table if not exists public.st_push (
  endpoint   text primary key,
  kullanici  text not null,
  p256dh     text not null,
  auth       text not null,
  cihaz      text,
  olusturma  timestamptz not null default now()
);

-- Telefondan/kısayoldan verilen komutlar (örn. "servis plana 20.11 ABC Ambalaj ekle").
-- Site açıldığında sıradaki komutları alıp tabloya işler.
create table if not exists public.st_komut (
  id         bigint generated always as identity primary key,
  kullanici  text not null,
  tur        text not null,
  veri       jsonb not null default '{}'::jsonb,
  metin      text,
  kaynak     text not null default 'site',
  durum      text not null default 'bekliyor',   -- bekliyor | isleniyor | uygulandi
  alindi     timestamptz,
  uygulama   timestamptz,
  olusturma  timestamptz not null default now()
);
alter table public.st_komut enable row level security;

-- Tablolar kilitli: politika YOK → sitedeki açık (anon) anahtarla okunamaz/yazılamaz.
-- Yalnızca "asistan" fonksiyonu (service role) erişir.
alter table public.st_ayar   enable row level security;
alter table public.st_oturum enable row level security;
alter table public.st_notlar enable row level security;
alter table public.st_push   enable row level security;

-- Zamanlayıcının fonksiyonu çağırırken kullanacağı gizli anahtar (veritabanında üretilir)
insert into public.st_ayar (anahtar, deger)
values ('cron_anahtar', to_jsonb(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')))
on conflict (anahtar) do nothing;

-- ── Hatırlatmalar: her dakika fonksiyonu çağır ──
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'st-asistan-hatirlatma';

select cron.schedule(
  'st-asistan-hatirlatma',
  '* * * * *',
  $cron$
  select net.http_post(
    url     := 'https://utemzjriobzggtleggqa.supabase.co/functions/v1/asistan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0ZW16anJpb2J6Z2d0bGVnZ3FhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NzE1MzIsImV4cCI6MjA5MjU0NzUzMn0.VRCqTzp1C06VK-OFeDMrfDrQn-pRU_OIE2f0t0tY3L8'
    ),
    body    := jsonb_build_object(
      'islem', 'cron',
      'anahtar', (select deger #>> '{}' from public.st_ayar where anahtar = 'cron_anahtar')
    )
  );
  $cron$
);
