# Bug report (draft, not filed): host aborts with `Assertion failed: (env) != nullptr`

Target: [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) · captured 2026-08-05
Full trace: `crash-trace.txt` (56 lines, ANSI stripped, verbatim from `logs/nanoclaw.error.log`)

**Not yet filed.** Read §6 before posting — one claim still needs checking.

---

## 1. Summary

The host process aborts (SIGABRT) with a Node assertion failure. A `better-sqlite3`
`Statement` is finalised by V8's garbage collector *after* the Node environment has
been torn down, so `RemoveEnvironmentCleanupHook` dereferences a null `env` and
aborts.

Each abort is an unclean exit, so the circuit breaker escalates the restart delay
(observed reaching `attempt=5, delaySec=120`). During the backoff the host is down:
`data/ncl.sock` disappears and every `ncl` command fails with `ECONNREFUSED`.

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

## 6. Leading hypothesis — needs one check before filing

**`better-sqlite3@11.10.0` against Node v24.** The package declares no `engines`
range, so nothing prevented the install, but 11.10.0 predates Node 24 and the
failure is precisely the shape of a native-addon lifecycle mismatch: a finalizer
running after environment teardown. `nanoclaw.sh` installs Node itself, so every
fresh install on a machine that gets Node 24 lands on this combination.

**Before filing, confirm:** whether upstream `better-sqlite3` has a known issue or a
fix released after 11.10.0 for `RemoveEnvironmentCleanupHook` / Node 24. If there is
a fixed release, this report becomes "please bump the pin" rather than a NanoClaw
defect, which is a materially different and much easier issue to action.

Also worth stating in the issue: it is unclear whether NanoClaw pins 11.10.0
deliberately (their `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320`, so a newer
release may simply not have aged in yet).

## 7. Why it is worth reporting regardless

Whatever the root cause, the *user-visible* behaviour is bad and is NanoClaw's to
own: a native abort escalates the circuit breaker, the host stays down through the
backoff, and every `ncl` command fails with a bare `ECONNREFUSED` that gives no clue
a crash-loop is in progress. Even with the dependency fixed, surfacing "the host is
crash-looping, see logs/nanoclaw.error.log" instead of a socket error would save the
next person the hour this cost.

## 8. Reproduction

Not deterministically reproduced. Observed on a fresh install within the first hour,
across four separate process lifetimes, with no unusual configuration. Anyone on
Node 24 + better-sqlite3 11.10.0 should be able to hit it by restarting the service
repeatedly.
