# Bug report (draft, not filed): host aborts with `Assertion failed: (env) != nullptr`

Target: [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) · captured 2026-08-05
Full trace: `crash-trace.txt` (56 lines, ANSI stripped, verbatim from `logs/nanoclaw.error.log`)

**Not yet filed.** §6 is resolved — the root cause is a Node defect, not a NanoClaw
one, which changes what this report should ask for. Re-read §1 and §6.5 before
posting.

---

## 1. Summary

The host process aborts (SIGABRT) with a Node assertion failure. A `better-sqlite3`
`Statement` is finalised by V8's garbage collector *after* the Node environment has
been torn down, so `RemoveEnvironmentCleanupHook` finds no current `Environment` and
aborts.

**The root cause is Node, not NanoClaw and not `better-sqlite3`.** Node **24.19.0**
backported [nodejs/node#63642][63642] — which made `node::ObjectWrap`'s destructor
call `RemoveEnvironmentCleanupHook()` — without the follow-up fix
[nodejs/node#63985][63985] that stops that call asserting when it runs during garbage
collection. 24.19.0 is the *only* release in that window; ≤24.18.0, 25.x, 26.0–26.3
and ≥26.4.0 are all unaffected. Node hit the identical assertion in its own test
suite: [nodejs/node#63923][63923]. Full derivation and the version matrix in §6.

NanoClaw is exposed because `nanoclaw.sh` installs Node itself, and because
`better-sqlite3@11.10.0` has no Node 24 prebuild and so compiles against the local
(broken) headers. Two independent fixes, either sufficient — avoid Node 24.19.0, or
bump `better-sqlite3` to ≥13.0.2. See §6.5.

Each abort is an unclean exit, so the circuit breaker escalates the restart delay
(observed reaching `attempt=5, delaySec=120`). During the backoff the host is down:
`data/ncl.sock` disappears and every `ncl` command fails with `ECONNREFUSED`. That
part is NanoClaw's to own regardless of the root cause — see §7.

## 2. The assertion

```
node[65468]: void node::RemoveEnvironmentCleanupHook(Isolate *, CleanupHook, void *) at ../src/api/hooks.cc:142
Assertion failed: (env) != nullptr

 1: node::Assert(node::AssertionInfo const&)
 2: node::RemoveEnvironmentCleanupHook(v8::Isolate*, void (*)(void*), void*) (.cold.1)
 3: node::AddEnvironmentCleanupHookInternal(...)
 4: Statement::~Statement()   [better-sqlite3@11.10.0/build/Release/better_sqlite3.node]
 5: Statement::~Statement()   [better-sqlite3@11.10.0/build/Release/better_sqlite3.node]
 6: v8::internal::GlobalHandles::InvokeFirstPassWeakCallbacks()
 7: v8::internal::Heap::PerformGarbageCollection(...)
 8: v8::internal::Heap::CollectGarbage(...)
```

Frames 4–8 are the whole story: GC runs, invokes the weak callback on a `Statement`,
the destructor tries to deregister its environment cleanup hook, and the environment
is already gone.

## 3. Environment

| | |
|---|---|
| NanoClaw | `2.1.54`, commit `86017fff` on `main` |
| Node | **v24.19.0** |
| better-sqlite3 | **11.10.0** (no `engines` field declared) |
| OS | macOS 26.5, arm64 (Apple silicon) |
| Docker | 29.6.1 |
| Install | fresh `nanoclaw.sh`, service under launchd (`com.nanoclaw-v2-<slug>`) |

## 4. Frequency and timing

Four aborts inside ~32 minutes on a fresh install, all during service start/stop
cycles:

```
23:04:01   23:32:59   23:33:56   23:36:30
```

Each is a distinct pid (65468, 65611, 66579, 66672) — a fresh process that starts,
runs channel registration, and dies. The crash-loop is self-sustaining: an abort is
an unclean exit, which raises the circuit-breaker delay, and the next start aborts
the same way.

## 5. What was happening around each abort

The last log line before each differs, which argues against any single feature
being the trigger:

| Abort | Preceding line |
|---|---|
| 23:04:01 | `Channel credentials missing, skipping channel="whatsapp"` |
| 23:32:59 | `Additional mount REJECTED group="Senior Dev"` |
| 23:33:56 | `Additional mount REJECTED group="Senior Dev"` |
| 23:36:30 | `Additional mount REJECTED group="Senior Dev"` |

All four are preceded within seconds by a `Channel credentials missing, skipping
channel="whatsapp"` warning. The common factor is a **startup path**, not any one
subsystem.

## 6. Root cause — resolved

The open question was whether `better-sqlite3` shipped a fix after 11.10.0 for
`RemoveEnvironmentCleanupHook` / Node 24. Checking the changelog, releases and both
issue trackers turned up a better answer: **the defect is in Node itself, and
`v24.19.0` — the exact version in §3 — is the only release that carries it.**

### 6.1 The mechanism

`node::ObjectWrap` lives in an *inline* header (`src/node_object_wrap.h`), so its
code is compiled into each addon's own `.node` binary against whatever Node headers
were present at build time.

[nodejs/node#63642][63642] ("src: add cleanup hooks to `node::ObjectWrap`", commit
`215027c8eded2e`, landed 2026-06-05) added a cleanup-hook registration to that
header — `~ObjectWrap()` now calls `RemoveEnvironmentCleanupHook()`. All four
`better-sqlite3` wrapper classes (`Database`, `Statement`, `StatementIterator`,
`Backup`) derive from `node::ObjectWrap`, so this call is inlined directly into
`Statement::~Statement()` — which is precisely frames 4–5 of our trace.

That change immediately destabilised Node's own test suite:
[nodejs/node#63923][63923] ("Flaky crash on worker-addon-exit test", 2026-06-15)
reports **the identical assertion**, with the same frame shape — a wrapper
destructor in an addon binary calling `RemoveEnvironmentCleanupHook`:

```
node[101420]: void node::RemoveEnvironmentCleanupHook(...) at ../../src/api/hooks.cc:130
Assertion failed: (env) != nullptr
 3: node::RemoveEnvironmentCleanupHook(...)
 4: MyObject::~MyObject()   [test/addons/worker-addon-exit/build/Release/binding.node]
```

The root cause, per Anna Henningsen in [nodejs/node#63985][63985]:

> the signatures of `AddEnvironmentCleanupHook()` and `RemoveEnvironmentCleanupHook()`
> are problematic. […] this model made the incorrect assumption that in the situations
> in which `RemoveEnvironmentCleanupHook()` would be invoked an `Environment` would
> always be associated with the current `Isolate`. **This occasionally breaks down when
> `RemoveEnvironmentCleanupHook()` is called during garbage collection**

That is exactly our stack: GC → weak callback → `~Statement` → no current
`Environment` → `CHECK_NOT_NULL(env)` fails.

[nodejs/node#63985][63985] ("src: keep global list of addon-provided cleanup hooks",
landed `68321eff8091`, 2026-06-20) fixed it by replacing the
`Environment::GetCurrent()` lookup with a global registry that returns early instead
of asserting.

### 6.2 Why v24.19.0 specifically

Node 24.19.0 backported the **breaking** change (#63642) without the **fix**
(#63985). Verified by reading `src/node_object_wrap.h` and `src/api/hooks.cc` at
each tag:

| Node | `~ObjectWrap` calls `RemoveEnvironmentCleanupHook` (#63642) | Global-registry fix (#63985) | Affected |
|---|---|---|---|
| 24.0.0 – 24.18.0 | no | no | no |
| **24.19.0** | **yes** | **no** | **yes — this crash** |
| 25.0.0 – 25.9.0 (whole line) | no | no | no |
| 26.0.0 – 26.3.0 | no | no | no |
| 26.4.0 – 26.6.0 | yes | yes | no |

Checked against every current release line as of 2026-08-05 (latest: 24.19.0, 25.9.0,
26.6.0). Note that **24.19.0 is the newest 24.x** — there is no fixed 24.x to upgrade
*forward* to, so on the 24 line the only move is back to 24.18.0. This is what makes
recommendation 1 below urgent rather than cosmetic: 24 is the active LTS line.

Corroborating detail: in `v24.19.0`, `RemoveEnvironmentCleanupHook` is at
`src/api/hooks.cc:138` and its `CHECK_NOT_NULL(env)` at **line 142** — matching the
`hooks.cc:142` in our assertion exactly. (Node's own report cites `:130`, the line
number on `main` at the time.)

### 6.3 Why a prebuilt binary does not save us

`better-sqlite3@11.10.0` publishes no Node 24 prebuild — its release assets stop at
ABI 131 (Node 23); Node 24 is ABI 137. Node 24 support was added in
[12.0.0][bs12] ("add node v24 to build matrix", PR #1371). So on Node 24 the package
**compiles from source against the locally installed headers** — and `nanoclaw.sh`
installs Node itself. A fresh install that lands on Node 24.19.0 therefore builds
`better_sqlite3.node` with the broken inline `ObjectWrap` and hits this every time
the process tears down with a live `Statement`.

This also explains the timing: 11.10.0 has been fine for a year. Nothing in NanoClaw
or `better-sqlite3` changed — Node 24.19.0 shipped on 2026-07-22.

### 6.4 Answer to the original question: does bumping the pin fix it?

**Bumping into 12.x does not.** Verified in source — every 12.x still uses
`node::ObjectWrap` and still calls `node::AddEnvironmentCleanupHook`
(`src/better_sqlite3.cpp:61` in 12.11.1, `:67` in 11.10.0). 12.x only fixes the
*silent-install* half: 12.0.0 added `"engines": {"node": "20.x || 22.x || 23.x || 24.x"}`
where 11.10.0 declares none.

**Bumping to 13.x does.** [13.0.0][bs13] (2026-07-21) migrated the addon to the
N-API / `node-addon-api`, dropping `node::ObjectWrap` entirely — the 13.x source
contains **zero** references to `EnvironmentCleanupHook`. Maintainer JoshuaWise
closed the closely-related [#1476][1476] ("Segmentation fault on worker exit", same
wrapper-survives-into-final-GC class) with *"better-sqlite3 has been migrated to use
N-API. Please try upgrading to v13.0.1"*. The targeted 12.x patch for that issue,
[PR #1477][1477], was **closed unmerged** in favour of the N-API rewrite — so there
will be no 12.x backport.

Caveats on 13.x, since it is a major:

- Use **≥ 13.0.2**. 13.0.1 regressed a *different* abort — [#1507][1507],
  `worker.terminate()` during an active call, `FATAL ERROR: Error::ThrowAsJavaScriptException`
  (23 failures/100 runs on 13.0.1 vs 0/500 on 12.11.1); fixed in 13.0.2.
- 13.x declares `"engines": {"node": ">=22"}`; NanoClaw's `package.json` declares
  `">=20"`. Bumping the dep narrows NanoClaw's own supported floor.
- 13.0.2 was published 2026-07-29 and clears the `minimumReleaseAge: 4320` (3 day)
  gate. 13.0.3 (2026-08-05) does not yet.

### 6.5 What to recommend upstream

Two independent fixes; **either** stops the abort, and they are worth doing in this
order:

1. **Avoid Node 24.19.0.** The cheapest and most complete fix, and it needs no
   dependency change. `nanoclaw.sh` installs Node, so NanoClaw controls this: pin
   the installer away from 24.19.0 (24.18.0, or 26.4.0+), and consider refusing to
   start on 24.19.0 with a pointer to [nodejs/node#63923][63923]. Worth reporting to
   Node as a bad backport — 24.19.0 is current LTS and *any* addon still using
   `node::ObjectWrap` is exposed, not just `better-sqlite3`.
2. **Bump `better-sqlite3` to ≥ 13.0.2.** Removes the exposure permanently by
   dropping `node::ObjectWrap`, and also gets an `engines` range so a future bad
   pairing fails at install instead of at runtime. Costs a major-version upgrade and
   a Node floor of 22.

The pin is almost certainly not deliberate: 11.10.0 predates all of this, and
nothing in the repo suggests it was chosen to avoid a known 12.x/13.x problem.

[63642]: https://github.com/nodejs/node/pull/63642
[63923]: https://github.com/nodejs/node/issues/63923
[63985]: https://github.com/nodejs/node/pull/63985
[1476]: https://github.com/WiseLibs/better-sqlite3/issues/1476
[1477]: https://github.com/WiseLibs/better-sqlite3/pull/1477
[1507]: https://github.com/WiseLibs/better-sqlite3/issues/1507
[bs12]: https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.0.0
[bs13]: https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0

### 6.6 Confidence

Not reproduced under a debugger. The chain is circumstantial but tight: the
assertion text, the `hooks.cc:142` line number, the inlined-destructor frame shape
and the affected-version window all agree, and Node's own maintainers describe the
same failure with the same trace. The one unverified link is that our aborts came
from a *main-thread* teardown GC, whereas Node's reproduction is a worker exit; the
`Environment`-not-current condition is the same either way.

## 7. Why it is worth reporting regardless

Whatever the root cause, the *user-visible* behaviour is bad and is NanoClaw's to
own: a native abort escalates the circuit breaker, the host stays down through the
backoff, and every `ncl` command fails with a bare `ECONNREFUSED` that gives no clue
a crash-loop is in progress. Even with the dependency fixed, surfacing "the host is
crash-looping, see logs/nanoclaw.error.log" instead of a socket error would save the
next person the hour this cost.

## 8. Reproduction

Not deterministically reproduced. Observed on a fresh install within the first hour,
across four separate process lifetimes, with no unusual configuration.

Given §6, the precise exposure is **Node 24.19.0 exactly** (not Node 24 generally)
plus any `better-sqlite3` below 13.0.0 *built from source* — which is what happens on
Node 24, since 11.10.0 ships no ABI 137 prebuild. Anyone on that pairing should be
able to hit it by restarting the service repeatedly. Downgrading to Node 24.18.0 or
upgrading to 26.4.0+ should make it stop; that is the cheapest confirmation of the
diagnosis and is worth doing before filing.
