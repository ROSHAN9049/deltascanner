-- Keep lease ownership tied to both the unique lease ID and worker ID.
-- Renewal calls the same function as acquisition; a live lease owned by a
-- different worker must never be overwritten by a worker presenting only a
-- matching lease ID.
create or replace function public.acquire_dd_lease(p_lease_id text, p_worker_id text, p_ttl_seconds integer)
returns boolean
language sql
as $$
  update public.dd_engine_lease
  set lease_id = p_lease_id,
      worker_id = p_worker_id,
      expires_at = now() + make_interval(secs => p_ttl_seconds),
      heartbeat_at = now()
  where id = 1
    and (
      expires_at is null
      or expires_at < now()
      or (lease_id = p_lease_id and worker_id = p_worker_id)
    )
  returning true;
$$;
