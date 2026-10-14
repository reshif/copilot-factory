---
name: console
description: Open the Factory Console, a read-only operations floor for every factory job. It has a board grouped by what needs the user, a line map of all jobs on one time axis, a live feed of everything that happens, and each job as a flow canvas (stages across, time down, every return trip, retry, park, amendment, cancel and abandon, which agents ran on which model, inspector findings) and as a readable story. Use when the user types /factory:console or asks to see, show, watch or visualise the factory, its jobs, or what the agents did.
argument-hint: "[job id, e.g. J-0003 — optional, to open that job first]"
---
# Factory Console

1. Run `factory console`. It reads `.factory/` without changing anything and writes `.factory/console.html`. Add `--job $ARGUMENTS` only if the user wants a page for that one job; otherwise include every job. The page opens on the board, with the jobs waiting for the user at the top.
2. Tell the user the path from the JSON's `written` field and that they can open it in a browser. If the session can show files to the user, send it. To open a particular job, add `#J-0003` (or that job's id) to the end of the file's URL.
3. In two or three lines, summarise the `jobs` list from the JSON: which jobs wait for them (`waiting`), which are running, parked or closed.
   - If `integrity` is `tampered`, say plainly that some records fail their seal and suggest `/factory:why` for that job.
   - If `integrity` is `not_checked`, say this machine has no factory key, so seals were not checked.

The page shows:
- **The floor.** Five tiles (your turn, running, parked, stopped, done) that are also filters, filters with counts on the left, and a filter box that takes words and tokens such as `is:waiting`, `risk:high`, `recipe:bug@low`, `gate:H2`, `has:finding`, `has:rework`, `agent:builder`, `since:2d`.
- **Board.** One row per job, grouped by attention: stage lights, the step or the gate it waits at and for how long, agents running now by model, tasks, return trips, retries, inspector findings and recent activity.
- **Line map.** Every job as a transit line on one time axis: stations per step, double rings for gates, dashed while waiting on the user, red return trips, parks, ends and follow-up transfers.
- **The wire.** Everything that happened across all jobs, newest first, including hook errors and refused "done" claims. Click a line to open that job at that moment.
- **A job.** *Line* is the flow canvas with replay: stages are columns, time runs downward, going back is a red line labelled with why, and each row shows the agents, results, findings, replies and guard blocks. *Story* tells the job in plain paragraphs and pins what it waits on with the exact reply to copy (e.g. `approve J-0004 H3`). *Tasks*, *Events* and *Lessons* too.
- **Recipe map** and **Crew**: the whole factory for any recipe, and the 19 agents with how often each ran.
- **Keys.** `j`/`k`, `Enter`, `Esc`, `/`, `⌘K` palette, `1`–`5`, `g w` (next job waiting for you), `?`.

## Watching live
If the user wants to watch a job as it runs (or asks for the console while a job is active), serve it instead: run `factory console --serve` **in the background** (it keeps running; with the Bash tool, set `run_in_background`). Its first output line gives the `serving` URL (`http://127.0.0.1:4477/` by default; `--port 0` picks a free port). Give the user that URL. The page then updates by itself as the hooks and the CLI write to `.factory/`: the LED says **live**, only changed rows redraw, a job that moves group slides there, and a new gate brings a toast with the reply to copy (and a desktop notification if they turn on the bell). An open job plays its new steps in if they are watching the latest moment and keeps their place if they are scrubbing back. It listens on this machine only and is still read-only. Don't start a second one if one is already serving.

A written file says **snapshot** instead of live. Never edit the page or `.factory/` to change what it shows. Re-run `factory console` to refresh a static page.
