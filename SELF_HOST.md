# Self-hosting Firecrawl

Want to get Firecrawl running? Start with the
[Firecrawl self-hosting guide](https://docs.firecrawl.dev/contributing/self-host).
It takes you from checkout to a successful scrape with Docker Compose.

Use this file when you are changing the baseline. It stays with the source, so
the services and configuration match the revision you checked out.

## Pick the guide for the job

| If you need to decide or do this | Start here |
| --- | --- |
| Decide whether self-hosting fits and run the first scrape | [Public self-hosting guide](https://docs.firecrawl.dev/contributing/self-host) |
| Check which variables and services exist at this revision | [Root Compose configuration](./docker-compose.yaml) |
| Run on a small host (2 vCPU / 2 GB) | [Small hosts](#small-hosts) and [`docker-compose.lite.yaml`](./docker-compose.lite.yaml) |
| Adapt a Kubernetes deployment | [Kubernetes manifests](./examples/kubernetes/cluster-install/) or [Helm chart](./examples/kubernetes/firecrawl-helm/) |
| Change Firecrawl product code | [Running Locally](https://docs.firecrawl.dev/contributing/guide), then the [contribution guide](./CONTRIBUTING.md) |
| Connect an agent or terminal client | [Local MCP](https://docs.firecrawl.dev/mcp-server/local) or [Firecrawl CLI](https://docs.firecrawl.dev/sdks/cli#connect-the-cli-to-self-hosted-firecrawl) |

## Keep the first run simple

- **Release: an exact tag.** Review the target release's Compose file before
  changing it. A checkout of `main` and floating image tags can change
  independently.
- **API authentication: `USE_DB_AUTHENTICATION=false`.** Add authentication
  after provisioning the required database schema and application
  configuration. Changing this variable alone is not a complete authenticated
  deployment.
- **Queue: NuQ PostgreSQL.** Keep it unless you intentionally set
  `NUQ_BACKEND=fdb` and are prepared to operate FoundationDB.
- **Scraping: bundled Playwright with basic fetch fallback.** Connect and
  configure a separate engine such as Fire-engine only when you need it.
- **AI-backed features: no model provider.** Connect OpenAI, an OpenAI-compatible
  endpoint, or Ollama when a feature needs it.
- **Queue administration UI: off.** Enable it only with a strong
  `BULL_AUTH_KEY` and restricted network access.

Get this baseline working before swapping backends or adding providers.

The root `.env` overrides only variables referenced by `docker-compose.yaml`.
Do not use `apps/api/.env.example` as a drop-in Compose contract.

## What the stack runs

At this revision, Compose runs the Firecrawl API and workers, Playwright, Redis,
RabbitMQ, NuQ PostgreSQL, and FoundationDB services for the optional queue
backend. Only the API is published to the host by default, on port `3002`.

Self-hosting gives you source and infrastructure control. You also own
security, availability, capacity, upgrades, data retention, and compliance.

## Small hosts

`docker-compose.lite.yaml` is the same stack sized for a 2 vCPU / 2 GB machine
such as an AWS `t3.small`. The default Compose file does not fit there: it runs
seven containers and, inside the API container alone, nine Node processes.

The API image has to come from this revision: `HARNESS_SERVICES` and the
harness's handling of a missing RabbitMQ are source changes, not Compose ones.
A published `ghcr.io/firecrawl/firecrawl` tag works only if it already contains
them.

The `api` service declares both `image:` and `build:`, so a first `up` with no
matching tag present **builds** rather than failing. That is intended when you
are building on the host, and surprising when you meant to pull — see the two
flows below.

**Build on the host.** Expect Rust, Go and a ~730-package pnpm install: tens of
minutes on 2 shared vCPUs. Give the box swap first; a 2 GB swapfile is enough
to get through dependency install and Rust compilation.

```bash
docker compose --env-file .env.lite -f docker-compose.lite.yaml up -d
```

**Build elsewhere and pull.** Better if you are deploying more than once, and
the only option if the host cannot spare the build time:

```bash
# on a machine with room to build, or in CI
docker compose -f docker-compose.lite.yaml build api
docker tag firecrawl-lite/api:local <account>.dkr.ecr.<region>.amazonaws.com/firecrawl-api:lite
docker push <account>.dkr.ecr.<region>.amazonaws.com/firecrawl-api:lite
```

Then set `FIRECRAWL_IMAGE` to that tag in `.env.lite` and pull explicitly, so a
missing tag is an error rather than a silent build:

```bash
docker compose --env-file .env.lite -f docker-compose.lite.yaml pull
docker compose --env-file .env.lite -f docker-compose.lite.yaml up -d --no-build
```

Match the architecture: `t3.small` is x86_64, so a build on an ARM machine needs
`--platform linux/amd64`. A `t4g.small` is the same 2 vCPU / 2 GB on Graviton
and removes the cross-build if you build on ARM.

Only the API image is affected. `playwright-service` and `nuq-postgres` are
unmodified upstream images and pull from ghcr.io as usual, both with amd64 and
arm64 variants.

Then, on the small host:

```bash
cp .env.lite.example .env.lite
docker compose --env-file .env.lite -f docker-compose.lite.yaml up -d
curl -X POST http://localhost:3002/v2/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "formats": ["markdown"]}'
```

Keep it in `.env.lite` and pass `--env-file`: the root `.env` belongs to
`docker-compose.yaml`, and these settings would break that stack.

Playwright and NuQ PostgreSQL are unmodified, so those pull from ghcr.io as
usual.

### What it drops, and what that costs you

| Removed | Why it is safe to remove | What you lose |
| --- | --- | --- |
| `rabbitmq` | Brokers `/v2/extract`, SIEM logging, and NuQ's prefetch hop. With `NUQ_RABBITMQ_URL` unset, NuQ workers take jobs straight from Postgres. | `/v2/extract` |
| `foundationdb`, `foundationdb-init` | Experimental queue backend, off unless `NUQ_BACKEND=fdb`. | Nothing at this revision |
| `extract-worker` | Connects to RabbitMQ on startup and needs a model provider. | `/v2/extract` |
| `nuq-prefetch-worker` | Its only job is publishing claimed rows to RabbitMQ. | Nothing without a broker |
| 4 of 5 `nuq-worker`s | Each handles one job at a time, so the count *is* the scrape concurrency. | Concurrent scrapes |

`/v2/scrape`, `/v2/crawl`, `/v2/map`, `/v2/batch/scrape` and `/v2/search` all
still work, with JS rendering, PDF and document parsing. The LLM-backed
features were already unavailable without a configured model provider.

### Sizing

Measured on a 2 vCPU host after a scrape, a JS-rendered page, a PDF and an
eight-page crawl, with the defaults in `.env.lite.example`:

| Container | Steady state | Limit |
| --- | --- | --- |
| `api` (`api`, `worker`, `nuq-worker` + harness) | pinned at its limit | 1024 MB |
| `playwright-service` | ~275-310 MB | 448 MB |
| `nuq-postgres` | ~97 MB | 160 MB |
| `redis` | ~13 MB | 64 MB |

That totals about 1.4 GB in use against 1.7 GB of limits — it works, with 32 MB
of swap touched and no OOM kills, but it is tight.

The API container behaves differently from the rest: V8 heaps expand into
whatever they are allowed, so it sits at ~100% of its cgroup whatever you set
(974 MB anonymous of a 1024 MB limit). That is expected, not a warning sign.
The lever that actually bounds it is `NODE_OPTIONS=--max-old-space-size`, which
has to *divide* `API_MEM_LIMIT` rather than approach it: each Node process
carries roughly 80 MB of non-heap on top of its heap, so budget about
`API_MEM_LIMIT / 4 - 80` per process and move the two together.

Dropping to `HARNESS_SERVICES=api,nuq-worker` with `API_MEM_LIMIT=768m` is the
configuration with genuine headroom: 664 MB used of 768 MB, ~1.05 GB across the
whole stack, scrape and JS rendering unaffected. It gives up crawl completion,
so it suits scrape-only deployments.

The other levers, in rough order of effect:

- `NUQ_WORKER_COUNT` (default `1`) is concurrent scrapes, since each NuQ worker
  handles one job at a time. `2` is the practical ceiling on 2 GB, with swap.
- `HARNESS_SERVICES` selects the processes: `api`, `worker` and `nuq-worker` by
  default. Adding `nuq-reconciler-worker` buys recovery of jobs stranded in the
  concurrency backlog for the cost of another Node process; dropping to
  `api,nuq-worker` frees ~350 MB and gives up crawl completion.
- `MAX_CONCURRENT_PAGES` should track `NUQ_WORKER_COUNT`; extra pages cost
  memory nothing is there to use.
- Removing `playwright-service` and setting `PLAYWRIGHT_MICROSERVICE_URL=`
  (empty, not absent) frees its ~275 MB and falls back to plain fetch: no JS
  rendering, screenshots, or actions.

`MAX_RAM` and `MAX_CPU` deserve a note. The queue worker sheds load above
them and, while shedding, stops accepting crawl-finish jobs — so a crawl scrapes
every page and then sits in `scraping` forever, with
`Can't accept connection due to RAM/CPU load` and `WORKER STALLED` in the logs.
The 0.8 defaults assume a host with spare capacity; this stack is sized to fill
a small one, so the lite Compose file raises both to 0.95. Concurrency is
already capped at one job by `NUQ_WORKER_COUNT`, so little is lost. Lower them
if the box is shared with something you care about more.

Two things bite on hosts this size regardless of configuration:

- **Configure swap.** The limits sum to ~1.7 GB, leaving ~300 MB for the kernel
  and dockerd on a 2 GB host. A 2 GB swapfile turns a burst into slowness
  instead of an OOM kill.
- **`native/Cargo.lock` is gitignored upstream.** Every from-scratch build
  re-resolves the whole Rust dependency tree against crates.io, so a newly
  published crate can break a build that worked yesterday — `tinyvec` is pinned
  in `native/Cargo.toml` for exactly that reason. Tracking a lockfile is the
  durable fix if you rebuild often.

`docker stats` is the check that matters, but read it with the heap behaviour
above in mind: the API container sitting near its limit is expected, an API
container being OOM-killed (`docker inspect --format '{{.State.OOMKilled}}'`)
is the actual signal to lower `--max-old-space-size` or `NUQ_WORKER_COUNT`.

## Before production

- **If the API will leave a trusted network,** add a complete authentication
  design, TLS termination, and network policy first. The default API is
  unauthenticated.
- **If data must survive service replacement,** add and test persistence,
  backups, and recovery for NuQ PostgreSQL, Redis, and RabbitMQ. The root
  Compose file defines no persistent volumes for them.
- **If you change the PostgreSQL settings,** keep the API and database values
  consistent. At this revision, the bundled `pg_cron` configuration targets
  the default `postgres` database.
- **If you publish dependency ports,** secure them explicitly. PostgreSQL,
  Redis, RabbitMQ, and worker ports should remain private by default.
- **If you have availability or scale targets,** define monitoring, resource
  limits, scaling triggers, and upgrade and rollback procedures. The checked-in
  Compose file is a source-aligned starting point, not a production
  architecture.

Treat the Kubernetes and Helm examples as versioned starting points, not as
evidence that these production decisions have been made for you.

Stuck? Open a
[self-host issue template](https://github.com/firecrawl/firecrawl/issues/new?template=self_host_issue.md)
or join the [Firecrawl Discord community](https://discord.gg/firecrawl).
