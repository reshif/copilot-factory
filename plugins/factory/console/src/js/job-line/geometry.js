// Stages are columns (each step a lane inside its stage); time runs down. Every visit
// to a step is a row: moving on is a line to the right, going back is a red line to the
// left, repeating a step drops straight down. Agents, results, your replies, guard
// blocks and inspector findings sit on the row where they happened.
const FG = { TIME_W: 84, STEP_W: 78, EMPTY_W: 44, STAGE_GAP: 12, PAD: 14, HEAD_H: 70, NODE_Y: 14, TITLE_H: 20, LINE_H: 16, CHIP_H: 20, CHIP_GAP: 4, LABEL_W: 380, TRANSIT: 26, INSP_W: 260, BOTTOM: 36 };
const BODY_FONT = '400 12.5px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
const TITLE_FONT = '600 13.5px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
const CHIP_FONT = '500 10.5px "IBM Plex Mono", ui-monospace, monospace';

function geometry(job) {
  const stages = [];
  const col = {};
  let x = FG.TIME_W + FG.PAD;
  for (const id of ORDER) {
    const steps = job.steps.filter((s) => s.stage === id);
    const w = steps.length ? steps.length * FG.STEP_W : FG.EMPTY_W;
    steps.forEach((s, k) => { col[s.id] = x + FG.STEP_W / 2 + k * FG.STEP_W; });
    stages.push({ id, x, w, steps });
    x += w + FG.STAGE_GAP;
  }
  const gridRight = x - FG.STAGE_GAP + FG.PAD;
  const insp = Boolean(job.inspector && job.inspector.length);
  return { stages, col, gridRight, insp, inspX: gridRight + 18, width: gridRight + (insp ? FG.INSP_W + 36 : 24) };
}

// ---------- live state
