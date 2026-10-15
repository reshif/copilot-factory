const ZONE_TOP = 120;
const HEADER = 78;
const NODE_GAP = 34;
const PAD = 16;
const BASE_W = { request: 270, contract: 330, design: 360, plan: 300, build: 400, verify: 360, ship: 290, learn: 290 };
let LAYOUT = null;

function layout() {
  const nodes = {};
  let x = 24;
  let maxBottom = 0;
  for (const st of STAGES) {
    st.x = x;
    // a bay is as wide as its widest workflow needs, so no agent label is cut off
    const need = Math.max(0, ...st.nodes.filter((n) => n.type === 'workflow').map((n) => {
      n.colWs = n.groups.map((g) => Math.max(...g.map((p) => textW(p.label, FONT_P) + 20)));
      return n.colWs.reduce((a, b) => a + b, 0) + (n.groups.length - 1) * 22 + 20 + PAD * 2;
    }));
    st.w = Math.ceil(Math.max(BASE_W[st.id], need));
    const innerW = st.w - PAD * 2;
    let y = ZONE_TOP + HEADER;
    for (const n of st.nodes) {
      n.stage = st.id;
      n.x = st.x + PAD;
      n.w = innerW;
      if (n.type === 'gate') {
        n.lines = wrap(n.title, FONT_T, innerW - 64);
        n.h = Math.max(54, 18 + n.lines.length * 17 + 14);
      } else if (n.type === 'workflow') {
        n.titleLines = wrap(n.title, FONT_T, innerW - 20);
        const cols = n.groups.length;
        const colGap = 22;
        n.colGap = colGap;
        const spare = innerW - 20 - (cols - 1) * colGap - n.colWs.reduce((a, b) => a + b, 0);
        n.colWs = n.colWs.map((w) => w + spare / cols);
        const maxPills = Math.max(...n.groups.map((g) => g.length));
        n.headH = 12 + 12 + n.titleLines.length * 17 + 8;
        n.h = n.headH + maxPills * 28 - 6 + 14;
      } else {
        n.titleLines = wrap(n.title, FONT_T, innerW - 20);
        n.subLines = n.sub ? wrap(n.sub, FONT_S, innerW - 20) : [];
        n.h = 12 + 12 + n.titleLines.length * 17 + (n.subLines.length ? n.subLines.length * 15 + 2 : 0) + 10;
      }
      n.y = y;
      y += n.h + NODE_GAP;
      nodes[n.id] = n;
    }
    st.contentBottom = y - NODE_GAP;
    maxBottom = Math.max(maxBottom, st.contentBottom);
    x += st.w + st.gapAfter;
  }
  const zoneBottom = maxBottom + 26;
  for (const st of STAGES) { st.y = ZONE_TOP; st.h = zoneBottom - ZONE_TOP; }
  const width = x - STAGES[STAGES.length - 1].gapAfter + 24;
  LAYOUT = { nodes, width, zoneBottom, height: zoneBottom + 120 };
}

// ===================================================================== render
