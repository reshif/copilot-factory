---
name: console
description: "Opens the read-only Factory Console page: a board of every factory job, a line map, a live feed and each job's story. Use when the user types /factory:console or asks to see, show or watch the factory or its jobs. Not for changing a job."
argument-hint: "[job id, e.g. J-0003 — optional, to open that job first]"
---
# Factory Console

1. Run `factory console`. It reads `.factory/` without changing anything and writes `.factory/console.html`. Add `--job <id>` only if the user gave a job id and wants a page for that one job; otherwise include every job. The page opens on the board, with the jobs waiting for the user at the top.
2. Tell the user the path from the JSON's `written` field and that they can open it in a browser. If the session can show files to the user, send it. To open a particular job, add `#J-0003` (or that job's id) to the end of the file's URL.
3. In two or three lines, summarise the `jobs` list from the JSON: which jobs wait for them (`waiting`), which are running, parked or closed.
   - If `integrity` is `tampered`, say plainly that some records fail their seal and suggest `/factory:why <job id>` for that job.
   - If `integrity` is `not_checked`, say this machine has no factory key, so seals were not checked.

If the user asks what the page shows or how to use it (views, filters, keys), read [references/ui-tour.md](references/ui-tour.md) and answer from it.

## Watching live
If the user wants to watch a job as it runs (or asks for the console while a job is active), serve it instead: run `factory console --serve` **as a background shell command** (it keeps running until stopped; start it so that it runs on in the background and doesn't block your turn). Its first output line gives the `serving` URL (`http://127.0.0.1:4477/` by default; `--port 0` picks a free port). Give the user that URL. The page then updates by itself as the hooks and the CLI write to `.factory/`: the LED says **live**, only changed rows redraw, a job that moves group slides there, and a new gate brings a toast with the reply to copy (and a desktop notification if they turn on the bell). An open job plays its new steps in if they are watching the latest moment and keeps their place if they are scrubbing back. It listens on this machine only and is still read-only. Don't start a second one if one is already serving.

A written file says **snapshot** instead of live. Never edit the page or `.factory/` to change what it shows. Re-run `factory console` to refresh a static page.
