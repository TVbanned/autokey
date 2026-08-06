alter table public.keyflow_activities add column if not exists review_requirement text not null default '测评要求：图文并茂，生动有趣';
