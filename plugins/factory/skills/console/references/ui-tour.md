# Factory Console: what the page shows

Read this only when the user asks what the console shows, how to find something on it, or what a view, filter or key does.

- **The floor.** Five tiles (your turn, running, parked, stopped, done) that are also filters, filters with counts on the left, and a filter box that takes words and tokens such as `is:waiting`, `risk:high`, `recipe:bug@low`, `gate:H2`, `has:finding`, `has:rework`, `agent:builder`, `since:2d`.
- **Board.** One row per job, grouped by attention: stage lights, the step or the gate it waits at and for how long, agents running now by model, tasks, return trips, retries, inspector findings and recent activity.
- **Line map.** Every job as a transit line on one time axis: stations per step, double rings for gates, dashed while waiting on the user, red return trips, parks, ends and follow-up transfers.
- **The wire.** Everything that happened across all jobs, newest first, including hook errors and stop-gate blocks. Click a line to open that job at that moment.
- **A job.** *Line* is the flow canvas with replay: stages are columns, time runs downward, going back is a red line labelled with why, and each row shows the agents, results, findings, replies and guard blocks. *Story* tells the job in plain paragraphs and pins what it waits on with the exact reply to copy (e.g. `approve J-0004 H3`). *Tasks*, *Events* and *Lessons* too.
- **Recipe map** and **Crew**: the whole factory for any recipe, and every agent with how often each ran.
- **Keys.** `j`/`k`, `Enter`, `Esc`, `/`, `⌘K` palette, `1`–`5`, `g w` (next job waiting for you), `?`.
