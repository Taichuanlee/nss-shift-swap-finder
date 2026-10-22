# PDF Phase 2: Publication v2 and nurse integration

Local implementation only. This continues the uncommitted Phase 1 changes. No deployment, KV migration, live schedule write, credential change or binding change is performed.

## Contract

The shared `SchedulePublication` adapter creates schema version 2 by default and reads both versions 1 and 2. `create(model, {version:1})` is retained for canonicalizing existing v1 data; no-number records cannot be downgraded.

Envelope: `format`, `schemaVersion`, server-reassigned `publishedAt`, `cycle` (start/end), `dates` (all supplied consecutive dates), `employees`, plus v2 `scope`, `cycleDates`, `referenceDates`, `provenance`.

- `cycleDates` must equal the exact 28 consecutive dates in `cycle`; `referenceDates` must equal all and only supplied dates outside that cycle. All shift keys must exactly match `dates`.
- Each employee has `id`, `name`, `employeeNumber` (string or null), `sourceRows`, `shifts`. Internal IDs are scoped records, never substitutes for employee numbers. A known employee number remains the preferred identity during one import; duplicate numbers in a publication are rejected.
- New imports receive independent scopes (browser `crypto.randomUUID`; a timestamp/sequence/two-random-component fallback supports older local runtimes). Date/year rebuilding reuses the original scope and row identities. v2 re-export preserves IDs. Known-number local parser keys remain compatible with existing local code; publication IDs are explicitly scoped when crossing the adapter.
- `sourceRows`: page (nullable for sheets), zero-based row, zero-based table, optional sheet name. Missing-number records require a source row. Duplicate source rows assigned to different records are rejected. No original file paths, metadata-column values, PDF bytes or full raw-cell evidence are published.
- `provenance`: source type, whether source evidence was available, confirmed-year decision (or null), cycle-confirmed flag, and accepted date corrections with original header text, corrected date, user/automatic decision and source position. These are audit metadata, never substitutes for structural validation.
- Blank shifts remain empty strings. Unknown nonblank codes, missing/extra shift keys, invalid or nonconsecutive dates, duplicate IDs/numbers, incompatible partitions and unexpected schema fields fail validation.

## Compatibility and safety

v1 remains readable, including every reference date actually supplied by v1. Its employee `id` is interpreted as the legacy employee number. It has no retained source-row/year/correction evidence; the loaded model explicitly marks source evidence unavailable and reference coverage as `provided-only`. A v1 dataset without boundary dates cannot be treated as having complete safety context.

The Worker uses the same adapter to validate, store and return v1/v2. Incoming versions are preserved when canonicalizing and hashing; only the publication timestamp is replaced on an actual write. Existing roles, cookies, origin checks, session checks, rate limiters, 256 KiB size limit, 366-date/1,000-record bounds and one-key KV write remain in force. Existing v1 KV data is read without an automatic rewrite. For synthetic-only mode, numbered records still require the existing synthetic number/name markers; no-number test fixtures additionally require an explicit `SYNTHETIC` plus digits scope and synthetic name marker. Ordinary imports cannot use their random local scope to bypass this guard.

The nurse UI searches name and employee number, displays source rows and a read-only 28-day preview before identity confirmation, and never labels an internal ID as an employee number. Same-name records remain separate. No-number identities are not persisted or automatically rematched across imports/cycles. Numbered identity memory stores only the employee number and still requires confirmation.

Only formal cycle days may be exchanged. All provided reference cells participate in work-run and fragmentation checks. Unknown cells are never rest boundaries. A candidate lacking the three-day context required by affected four-day fragmentation windows, or with an affected work run reaching an unobserved boundary, is excluded with a distinct context count. Existing same-shift restrictions and consecutive-work/fragmentation rules otherwise remain in place; this phase adds no cross-shift override.

## Validation and release boundary

Regression fixtures are fictional. Four original PDFs in Downloads are read locally and passed through parsing, explicit diagnostic date decisions, v2 serialization, in-memory Worker publish/read and nurse adapter/search/calendar checks. Raw PDFs and publications are never saved in this repository.

Deployment requires rebuilding the integrated package from this complete working tree, retaining the current live `SYNTHETIC_ONLY` setting deliberately, and separate user authorization. The build template still defaults to string `true`; it must not inadvertently overwrite an already authorized live `false`. No setting has been changed by this implementation.

The local Worker binding doubles and browser tests do not establish actual Cloudflare deployment/KV propagation behavior. Central schedule replacement/synchronization acceptance and live verification remain separate work.
