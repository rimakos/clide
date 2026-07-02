# Workspace — Cross-Repo System Map

Operational map, not architecture doctrine. Evidence-backed. When this conflicts
with production data / payload / log evidence, **evidence wins** and this file gets
updated.

Status legend per statement: ✅ **Confirmed** (file:line or directory evidence),
🟡 **Inferred** (derived from confirmed evidence), ⬜ **Unknown** (not verified).

## Evidence Rule

- Production data rows, real payloads, and prod logs **outrank** negative grep results.
- "I didn't find it with grep" is not proof a path doesn't exist. Generated clients,
  reflection, string-built queries, DI, and message subscriptions hide call sites.
- Before claiming "X doesn't happen," cite the positive evidence path.

## Repo Roles

<!-- Fill from os-config.yaml. One row per repo. Tag each with ✅/🟡/⬜. -->

| Repo         | Role                                            | Evidence |
|--------------|-------------------------------------------------|----------|
| `api`        | Backend of record — owns the data model         | ⬜       |
| `web`        | Customer-facing SPA, calls api via gen client   | ⬜       |
| `shared-lib` | Shared package consumed by multiple repos       | ⬜       |

## Communication Topology

<!-- Draw the real call graph. Arrows = who calls whom. Mark each edge's evidence.
     Replace this ASCII sketch with your actual topology. -->

```
        ┌─────────────────────┐
        │        api          │   backend of record
        └─────────────────────┘
           ▲               ▲
   REST /  │               │  REST /
   gen     │               │  gen client
   client  │               │
   ┌───────┘               └────────┐
   │                                │
┌──────────┐                  ┌──────────────┐
│   web    │                  │  other repo  │
└──────────┘                  └──────────────┘

  Message bus (async) — topics: <list>. Consumers: <list>.
```

## Seams (integration boundaries)

<!-- One subsection per seam from os-config.yaml. Link to the seam page. -->
- `api-web` — see [[api-web]]. ⬜
- `api-bus` — see [[api-bus]]. ⬜
