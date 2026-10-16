# Drive, inbox and recovery

This page covers how a job is driven from start to finish: who runs each step, where it stops for you, how you are told, and what the factory does on its own when something fails before it asks you. The code is in `cli/core/drive.js`, `cli/core/inbox.js`, `cli/core/notify.js`, `cli/core/decision-table.js` (`park`) and `workflows/realize.js` (scheduling).

## `factory drive`

`factory next` decides every step, and most steps are mechanical:
- run a workflow (`factory run <workflow>`, including clarify's agent stages);
- run a CLI step (`plan from-contract`, `verify run`, `ci verify`, `pr sync`, `close`);
- ship;
- distill.

`factory drive` does those steps itself, in a loop:

```
factory drive [--job J] [--max-steps n]       # foreground: prints one JSON stop when it stops
factory drive --detach                        # the same in the background: log in .factory/drive.log
factory drive status [--wait <seconds>]       # where it is; --wait blocks until it stops (or the wait ends)
factory drive stop                            # SIGTERM: it stops the step in progress, records the stop, exits
                                              # (a stale record — that drive is gone — is cleared, nothing signalled)
```

Each step runs as its own `factory` child process. These are the same command lines the main session would run, and each is logged in `.factory/log/events.jsonl` with `via: "drive"`. The router, the run lock and the inspector therefore see what they would see for a job driven by hand.

### Where it stops

Every stop has a `kind`:

| kind | When | What the human or the main session does |
|---|---|---|
| `gate` | A human gate: H1, H2, H3, HF, HS, EH1–EH3 or A | Reply `approve` or `deny <what must change>` |
| `clarify` | Clarify waits on the user: the read-back, the decision sheet, or a redirect read-back | Reply `ok`, or say what to change / answer the sheet |
| `questions` | Ground's blocking questions | Answer them; the main session records each answer with `factory answer` |
| `degraded` | A workflow ran without an angle | Re-run it, or go on without it (`--accept-degraded`) |
| `parked` | The job parked, with a typed reason (see below) | `resume`, or the change it suggests |
| `wait` | The merge, an open PR, or a criterion only you can check | `merged <commit>`, merge on GitHub, or `confirm AC-n` |
| `amend` | An amendment needs writing (what changed, and who asked) | The main session follows the amend skill |
| `evidence` | A doc or diff record the drive can't pick a file for | The main session checks the build and records it |
| `ship` | Only with `policy.drive.stop_before_ship: true`: every pre-ship floor is met, and the push, the PR or the local merge waits for your go | Say to ship; Copilot runs `factory ship`, then the drive again |
| `done` | The job is closed, cancelled or abandoned | — |
| `step_too_long` | Two drives in a row were killed in the same step (a shell tool's time limit stops a foreground drive mid-step; see below). The step is not started a third time | Run `factory drive --detach`, or the step in your own terminal |
| `copilot_unavailable` · `transient` · `error` · `interrupted` · `limit` · `superseded` | Copilot is missing, signed out, or rate-limited; a step failed twice; the drive was stopped; it hit its step limit (per job); another drive took over | Fix the cause, then run `factory drive` again |

A stop that is a failure (`error`, `copilot_unavailable`, `transient`, `limit`, `interrupted`, `superseded`) exits 1; a stop that waits on the human, and `done`, exit 0.

**Stop before ship.** `policy.drive.stop_before_ship` (default `false`) makes the drive stop with kind `ship` instead of running `factory ship`, so nothing is pushed, opened as a PR or prepared for a local merge until you say so. Without it the drive ships as the main session did before: at high risk only after the HS sign-off gate, at low and medium risk at once.

**It never answers for you.** The drive runs none of the human-only verbs: `approve`, `deny`, `resume`, `proceed`, `cancel`, `abandon`, `waive`, `merged`, `confirm`, `finding accept|dismiss`, `env set`, `assumption`, `reseal` or `lessons accept|reject|promote`. It does not run `clarify reply` or `clarify redirect` either. Those stay yours: your chat reply goes through the prompt hook, or you run the command in your own terminal and type the code shown there. Don't paste that code into a chat. No agent may ask you for it.

**Evidence the CLI can check.** A doc or diff record is made by the drive only when exactly one file of that kind changed in the tasks that cover the criterion: one documentation file for `doc`, one changed file for `diff`. Its note says so. Otherwise the drive stops with `evidence`.

**Each stop:**
- prints one JSON object. It holds `kind`, a one-line `summary`, what to reply in chat (`reply`), the terminal command (`command`) and `next`, the `factory next` output at that stop. The gate, park and clarify skills read their fields from `next`;
- writes a `drive_stop` event, typed by `kind` (plus the gate, park kind or clarify stage), so the inspector can check that every stop reached you;
- updates `.factory/drive.json`;
- prints a line on stderr;
- sends a desktop notification.

**Safe to rerun.** The drive keeps no state of its own beyond `.factory/drive.json`. Each step it takes is a fresh `factory next`. Rerun it after a stop, a crash or a reboot, and it continues from where the job is:
- A drive that died without a stop (killed, or its machine slept) is taken over by the next one. Its `drive_start` event records `recovered_from`.
- A `factory run` that is still running from before (`run_in_progress`) is waited for. A result already recorded is never run again.

**One drive at a time** per repository. `.factory/drive.json` holds its pid, host and a heartbeat every 10 s, and is taken under an O_EXCL lock file (`.factory/drive.lock`), so two drives started together can't both win. Whether a recorded drive is still running is decided by what can be known about it:
- on this machine, by its process: `drive.json` also records the process's start time (`pid_start`: `/proc/<pid>/stat` field 22 on Linux, `ps -o lstart=` on macOS and the BSDs). A live pid that started at that time is the drive, however old its heartbeat (a laptop that slept is not taken over). The same pid with another start time is a later process that reused the number, and the drive is gone, whatever that process runs;
- on this machine with nothing reliable to compare (Windows, or a record written before 0.8.1): a gone pid, or one that is no node/factory process, is gone; otherwise the heartbeat decides, as on another machine (the drive beats every 10 s while a step runs, so only a dead or frozen drive goes stale);
- on another machine (a container restarted under a new hostname), only by its heartbeat: a minute without one and it counts as gone, and `factory drive stop` never signals a pid another machine recorded.

A record whose drive is gone never holds the repository: the next `factory drive` takes it over, and `factory drive stop` clears it (status `stopped`, event `drive_cleared`) without signalling anything, so a reused pid is never sent a signal.

Each drive re-reads `drive.json` before every step and every heartbeat. One that finds another drive's pid there has been taken over: it stops (kind `superseded`, event `drive_superseded`) without writing over the new owner's record or touching the job.

While a drive runs, anyone else's `factory next` answers `action: "driving"` (with `factory drive status --wait 600` as the way to wait), and `factory run` is refused with `drive_in_progress`. The stop hook lets the main session end its turn while a drive runs.

**In the chat.** The start skill starts `factory drive --detach` and waits with `factory drive status --wait 240`, under its shell tool's time limit, until the drive stops; then it relays the stop. It never runs the drive in the foreground: a tool's time limit would stop the drive and the build it runs. A detached drive runs in its own session and process group, so no tool time limit reaches it, however long a step (`verify run`, `ci verify`, a build) takes; `drive status --wait` only reads `drive.json`, so a wait cut short by a time limit loses nothing.

**A step longer than a tool's time limit.** A drive run in the foreground anyway (by hand under a tool, or a host that can't background) is killed with the tool's call. A rerun would start the same step again and be killed again, without end. So each drive records the step it was killed in: in `drive.json` (`step`, when it died without a stop) or in its `interrupted` stop (`in_step`, when the signal reached it in the foreground). The next drive's `recovered_from` carries the step and how many drives in a row were killed there. When a second drive in a row is killed in the same step, the third does not start it: it stops with kind `step_too_long`, naming the step, and says to run `factory drive --detach` (or the step in your own terminal). Any other stop, or the step running through, starts the count again. A detached drive is counted only when it died without a stop (out of memory, SIGKILL), never for `factory drive stop`. After you reply, it starts the drive again; an `interrupted` drive is simply started again. It no longer steps `factory next` by hand. That way of working stays in the skill only for hosts that can neither keep a long command running nor background one.

## `factory inbox`

`factory inbox [--format md]` lists everything waiting on you, across jobs. It is read-only: it routes nothing and writes nothing. Each item gives:
- the gate (with its hash and documents), the clarify turn (with its screen) or the park (with its kind and suggested next step), the merge, or a drive stop that needs the main session;
- what to reply in chat;
- the terminal command. A human-only one asks you to type a code shown on that terminal.

The console's `--serve` page shows the same list above the board ("Waiting on you"), with the drive's state.

## Notifications

Every drive stop sends a desktop notification. The drive picks the notifier for the platform:

| Platform | Notifier |
|---|---|
| Linux | `notify-send` |
| WSL | `wsl-notify-send.exe` when it is on PATH, else a `powershell.exe` toast |
| macOS | `osascript` (`display notification`) |
| Windows | a PowerShell toast |
| none found | a terminal bell on the controlling terminal |

WSL is detected by `/proc/version` naming Microsoft/WSL, or by `WSL_DISTRO_NAME` being set.

Notifications are best effort and never block. The notifier is started detached, its output ignored, and never waited on; a failure is swallowed and the drive goes on. Each attempt is logged as a `notify` event (the method and `result: spawned`, or `off`; the factory can't see whether the desktop showed it). A rerun that stops at the same gate, park, clarify turn or merge again doesn't notify a second time (`notified: repeat`).

**No text is ever script.** The title and body can carry agent-written words (a park reason), so they never become part of a script's text. PowerShell reads them from environment variables (`$env:FACTORY_NOTE_TITLE`, `$env:FACTORY_NOTE_BODY`; from WSL they cross to Windows through `WSLENV`), osascript gets them as `argv` of a constant AppleScript, and `notify-send` / `wsl-notify-send` get them as arguments after `--`. Control characters are stripped. The Windows toast uses PowerShell's own registered app id, so Windows shows it.

`policy.notify` turns them on (`true`, the default) or off (`false`). `FACTORY_NOTIFY=off` turns them off for one process.

## Typed recovery

Before it parks, the factory does what a program can.

| Failure | What happens |
|---|---|
| **Transient**: the Copilot CLI's own error line on stderr (`Error: …`, `CAPIError …`) with an HTTP status in context (`status code 429`, `HTTP 503`, `502 Bad Gateway`), `rate limit exceeded` / `Too Many Requests`, or a dropped connection (`ECONNRESET`, `ETIMEDOUT`, `fetch failed`, …). Never stdout (the agent's reply), a bare number, or `ECONNREFUSED` (a local service the agent's tests needed) | The same agent turn is spawned again after a backoff: exponential from `copilot.transient_backoff_seconds` (10), capped at 2 min, ±50% jitter. The workflow never sees the failure, so **no attempt is spent**. After `copilot.transient_retries` (4) the run stops with `copilot_transient` and records nothing; the drive stops with `transient`. A failure that keeps coming back is not transient: after `copilot.transient_park_after` (3) such runs in a row the job parks with kind `transient` (`resume` counts afresh; a run that records resets the count). |
| **`dependency_conflict`** (task start can't merge the job branch or a dependency into Tn) | Tn's next start restarts its branch from the integrated job branch, and realize rebuilds it there **once**, without spending an attempt. A second conflict is the typed `blocked: dependency_conflict` result, and the park suggests the plan change. |
| **Reconcile regression on Tn** (integrating would drop a line already merged) | Tn is reopened (`needs_work: integration`, with the dropped lines as its failure input) and rebuilt on the merged code **once**, automatically. The same regression again parks with kind `regression`. |
| **`environment_broken`** | The job parks once with the failing command and the tail of its output; no builder attempt is spent (0.6). |
| **`scope_violation`** | The task restarts from the job branch (0.6). |
| **Invalid output** | One correction turn in the same session (0.4). |

**Every park is typed.** `state.park` carries `kind` and `next`, the suggested step, for example:
- `needs_paths`: T2 needs `src/index.js`, so amend the plan to give it those paths;
- `dependency_conflict`;
- `regression`;
- `environment_broken`;
- `task_exhausted`;
- `review_rounds`;
- `verify_fix_rounds`;
- `unverified_finding`;
- `no_progress`;
- `budget`;
- `scope_violation`;
- `clarify`;
- `transient`.

A park the router makes is recorded with its routing decision; a park from a workflow result is logged as its own decision row (`action: "park"`, rule `park.<kind>`). `factory why` lists them under `parks`, and `factory why --format md` shows each park with its kind, reason and next step.

**An amendment pre-empts a park.** `amend submit` on a parked job puts gate A in front of you, and approving it also resumes the job; it needs no separate `resume`. Denying it keeps the park.

**No false dead-hook notice.** `factory next` on a parked job no longer says chat replies aren't reaching the factory just because it was asked twice; a park is not evidence of a dead hook.

## Scheduling by dependency

Realize used to build wave by wave: every task of a wave, its retries included, finished before the next wave started. Now:
- **A task starts as soon as its own dependencies are integrated**: merged into the job branch with the job's checks passing. Without per-wave integration, it starts once they are done.
- At most `limits.max_parallel_tasks` tasks run at once.
- Each task runs its own build, verify and retry loop, so nothing waits for a sibling.
- Done tasks are integrated as they finish (`factory reconcile wave`), one integration at a time. Each batch is the set of done tasks not yet integrated.
- **No attempt starts or retries** while an integration's checks run, or while a failed integration is being repaired (except the repair's own attempts): every attempt, the first and each retry, passes one barrier, which also keeps at most `max_parallel_tasks` attempts at work.
- A task starts from the job branch **as last integrated green** (`state.integration_green`), not from its moving head, so a builder's `task start` never merges a merge whose checks are running or failed. A task reopened to repair an integration starts from the job branch itself: it must see the merge it fixes.
- The integration's checks can still run while builders already at work run their own verify commands. Shared services or ports in your verify commands can then collide; give them per-worktree names, or set `limits.integrate_each_wave: false`.

**A broken integration still stops what would build on it.** The failure goes back, with its raw output, to the task whose files it names, and that task is rebuilt on the integrated branch. Until the batch integrates cleanly, nothing new starts and nothing else is integrated on top of it. If it can't be fixed, the tasks not yet started end `skipped_dependency`, as the 0.6.0 wave guarantee did.

**Simulation** (the build audit's scenario, 1 unit = 1 min):
- T1 builds in 10 min. T2 takes 25 min per attempt and fails twice. T3 depends on T1 and T4 on T3, 10 min each. Verify takes 2 min.
- Wave by wave, T4 was built by minute 107–109 and the job ended at 107–110, depending on how long each integration takes (none, 0 min or 1 min).
- By dependency, T4 was built by minute 37–40, close to the 36-minute critical path (attempts wait while an integration's checks run). The job ended at 81–83, bounded by T2's own three attempts.

## Upgrading with a job in flight

A job started on 0.7.0 continues under `factory drive` with nothing to migrate:
- A park from before has no kind; `factory next`, `why`, the inbox and the drive derive one from its reason and where it came from.
- `drive.json` is created by the first drive.
- A realize run that started before the upgrade finishes as it began. The next one schedules by dependency.
