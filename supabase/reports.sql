-- Run once in the Supabase SQL editor, after slugs.sql. Safe to run again.
--
-- Anyone logged in can report an addon: a dead link, a harmful download, a duplicate.
-- Reports wait for an admin, who deals with the addon and closes the report. Visitors
-- who are not logged in cannot report, so the database takes no anonymous writes.

create table if not exists public.reports (
	id bigint generated always as identity primary key,
	-- A report goes when its addon does: deleting the addon is the answer to it.
	addon_id bigint not null references public.addons on delete cascade,
	reason text not null check (reason in ('broken', 'wrong-client', 'duplicate', 'harmful', 'other')),
	note text not null default '' check (char_length(note) <= 500),
	reported_by uuid references public.profiles on delete set null,
	reported_by_name text,
	-- handled: an admin acted on it. dismissed: nothing was wrong.
	status text not null default 'open' check (status in ('open', 'handled', 'dismissed')),
	decided_by uuid references public.profiles on delete set null,
	decided_at timestamptz,
	created_at timestamptz not null default now()
);
-- One open report per account per addon; reporting again while it waits changes nothing.
create unique index if not exists reports_open_idx on public.reports (addon_id, reported_by) where status = 'open';
create index if not exists reports_status_idx on public.reports (status);

alter table public.reports enable row level security;
drop policy if exists "admins read reports" on public.reports;
create policy "admins read reports" on public.reports for select to authenticated using (public.is_admin());
-- Written through the functions below only.
revoke all on public.reports from anon, authenticated;
grant select on public.reports to authenticated;

create or replace function public.report_addon(addon bigint, reason text, note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
	label text;
begin
	if auth.uid() is null or public.is_banned() then
		raise exception 'You need to be logged in to report an addon.';
	end if;
	select name into label from public.addons where id = addon;
	if label is null then
		raise exception 'That addon no longer exists.';
	end if;
	if (
		select count(*) from public.reports where reported_by = auth.uid() and created_at > now() - interval '1 day'
	) >= 10 then
		raise exception 'You can send at most 10 reports a day.';
	end if;

	insert into public.reports (addon_id, reason, note, reported_by, reported_by_name)
	values (
		addon,
		reason,
		btrim(coalesce(note, '')),
		auth.uid(),
		(select username from public.profiles where id = auth.uid())
	)
	on conflict (addon_id, reported_by) where status = 'open' do nothing;
	if found then
		perform public.log_action('report.create', label, addon, jsonb_build_object('reason', reason));
	end if;
end;
$$;

-- Closes an open report. Admins only.
create or replace function public.decide_report(report bigint, outcome text) returns void
language plpgsql security definer set search_path = '' as $$
declare
	r public.reports;
begin
	if not public.is_admin() then
		raise exception 'Only admins can close reports.';
	end if;
	if outcome not in ('handled', 'dismissed') then
		raise exception 'Unknown outcome.';
	end if;
	update public.reports
	set status = outcome, decided_by = auth.uid(), decided_at = now()
	where id = report and status = 'open'
	returning * into r;
	if r.id is null then
		raise exception 'That report has already been closed.';
	end if;
	perform public.log_action(
		case outcome when 'handled' then 'report.handle' else 'report.dismiss' end,
		(select name from public.addons where id = r.addon_id),
		r.addon_id,
		jsonb_build_object('reason', r.reason)
	);
end;
$$;

revoke all on function public.report_addon(bigint, text, text) from public, anon;
revoke all on function public.decide_report(bigint, text) from public, anon;
grant execute on function public.report_addon(bigint, text, text) to authenticated;
grant execute on function public.decide_report(bigint, text) to authenticated;
