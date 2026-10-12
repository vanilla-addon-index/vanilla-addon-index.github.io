-- A visitor's browser asks for the addons posted or edited since the snapshot it was
-- given: "updated_at" later than a moment. With this index that question is answered
-- without reading the whole list, however long it grows and however many ask.
create index if not exists addons_updated_at_idx on public.addons (updated_at);
