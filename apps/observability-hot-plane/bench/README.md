# Hot-plane dashboard benchmark

Measures how many concurrent console dashboard users one dev ClickHouse node serves. The node is a
`t4g.medium`, with 2 vCPU, 4 GiB of RAM, and a gp3 volume at 3,000 IOPS and 125 MiB/s. The bench
runs on the same container limits.

The scripts need Docker through `sudo -n docker`. Set `BENCH_DOCKER` to change that command. Run
them from the repository root.

1. Start ClickHouse at the pinned version, with the module's bootstrap XML and the node's limits:

   ```bash
   bun apps/observability-hot-plane/bench/clickhouse.ts start
   ```

2. Load the synthetic dataset with the repository's DDL. The default is 2 million facts over 30 days
   across 50 organizations. Each organization has a busy environment and a quiet one, and the
   traffic is skewed. Loading takes about 30 seconds.

   ```bash
   bun apps/observability-hot-plane/bench/seed.ts 2000000
   ```

3. Check that the tenant-first reads return what the `active_facts` view returns for every tenant
   and window. This takes about 2 minutes.

   ```bash
   bun apps/observability-hot-plane/bench/equivalence.ts
   ```

4. Compare a baseline commit with this worktree. Each run applies its side's users profile and
   serves its side's API in a container sized like the dev ECS task (0.25 vCPU, 512 MiB). The sides
   alternate, five rounds of 15 seconds per concurrency level:

   ```bash
   bun apps/observability-hot-plane/bench/compare.ts final HEAD 1,2,4,8,16,24 15 5
   bun apps/observability-hot-plane/bench/summary.ts final 2000
   ```

5. Stop ClickHouse and remove its volume:

   ```bash
   bun apps/observability-hot-plane/bench/clickhouse.ts stop
   ```

A virtual user loads the overview, the metrics screen, and the trace list in parallel, then loads
them again, in a closed loop. That is seven hot-plane calls per load. Each screen sends its calls
the way `apps/console/src/server/hot-plane-queue.ts` does, with two in flight and a retry after
each 429. Users rotate through the 100 tenants. Each load moves its window by one millisecond, so
no load reuses a cached response from an earlier load. The bench changes only the server config
and the users profile. It does not reproduce the Kinesis writer, ingest, or background merges.
