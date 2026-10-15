// epicpick.js: the one epic picker every Epics screen uses (the classic Epics view and each display): a native
// <select> whose option labels tell apart epics that share a slug ("copilot-port · intent · 12 Oct 06:17 UTC": state in
// words, creation time in UTC from created_at, else from the id).
// In-flight epics come first (most recently updated first), then the finished ones (complete, cancelled, abandoned),
// in an "In flight" / "Finished" optgroup each when both exist. The default is the in-flight epic that waits on you,
// else the most recently updated in-flight one, else the most recent. Built with DOM APIs only.
// An entry: { id, slug, state, created (ms or NaN), updated (ms or NaN), you (bool) }.
APP.epicPick = (function () {
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var FINISHED = { complete: 1, cancelled: 1, abandoned: 1 };
  var WORD = {
    epic_intent: "intent", awaiting_epic_intent_approval: "intent sign-off",
    epic_architecture: "architecture", awaiting_architecture_approval: "architecture sign-off",
    slicing: "slicing", awaiting_slice_plan_approval: "slice plan sign-off", in_delivery: "delivery",
    epic_gate: "epic gate", epic_review: "review", complete: "complete", parked: "parked",
    amending: "amending", awaiting_amendment_approval: "amendment sign-off", cancelled: "cancelled", abandoned: "abandoned"
  };
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : NaN; }
  function parse(s) { var t = typeof s === "string" ? Date.parse(s) : NaN; return isFinite(t) ? t : NaN; }
  // the id carries its UTC creation time: E20261012-061722-copilot-port
  function fromId(id) {
    var m = /^E?(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(id || ""));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
  }
  function when(ms) { var d = new Date(ms); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC"; }
  function word(state) { return WORD[state] || String(state || "unknown").replace(/_/g, " "); }
  function done(e) { return !!FINISHED[e.state]; }

  // an entry from one epic of the display document (raw or a display's normalised copy)
  function fromDisplay(e, you) {
    var h = Array.isArray(e.history) ? e.history : [], last = NaN;
    h.forEach(function (x) { var t = x ? parse(x.at) : NaN; if (!isNaN(t) && (isNaN(last) || t > last)) last = t; });
    var created = parse(e.created_at);
    if (isNaN(created)) created = fromId(e.id);   // the id carries its creation time too
    var updated = parse(e.updated_at);
    if (isNaN(updated)) updated = isNaN(last) ? created : last;
    var w = e.waiting_on && typeof e.waiting_on === "object" ? e.waiting_on : {};
    return { id: String(e.id || e.slug), slug: String(e.slug || e.id), state: e.state || "", created: created, updated: updated,
             you: you !== undefined ? !!you : w.who === "you" };
  }
  function norm(e) {
    var c = num(e.created); if (isNaN(c)) c = fromId(e.id);
    var u = num(e.updated); if (isNaN(u)) u = c;
    return { id: String(e.id), slug: String(e.slug || e.id), state: e.state || "", created: c, updated: u, you: !!e.you };
  }
  function byRecent(a, b) { return (isNaN(b.updated) ? -Infinity : b.updated) - (isNaN(a.updated) ? -Infinity : a.updated) || (b.created || 0) - (a.created || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

  // ordered, labelled choices: { flight: [...], finished: [...] }, each { id, label, title, you, done }
  function choices(list) {
    var es = (list || []).filter(function (e) { return e && e.id; }).map(norm);
    var flight = es.filter(function (e) { return !done(e); }).sort(byRecent), fin = es.filter(done).sort(byRecent);
    var all = flight.concat(fin), seen = {};
    all.forEach(function (e) {
      e.done = done(e);
      e.label = e.slug + " · " + word(e.state) + (e.you && !e.done ? " · waits on you" : "") + (isNaN(e.created) ? "" : " · " + when(e.created));
      e.title = e.id + (isNaN(e.updated) ? "" : " · last change " + when(e.updated));
      seen[e.label] = (seen[e.label] || 0) + 1;
    });
    all.forEach(function (e) { if (seen[e.label] > 1) e.label += " · " + e.id; });
    return { flight: flight, finished: fin };
  }
  // the id to show: the remembered one if it still exists, else the default
  function preferred(list, saved) {
    var c = choices(list), all = c.flight.concat(c.finished);
    if (saved && all.some(function (e) { return e.id === saved; })) return saved;
    var pick = c.flight.filter(function (e) { return e.you; })[0] || c.flight[0] || all[0];
    return pick ? pick.id : null;
  }
  // (re)fill a <select> in place; skipped when nothing changed, so a poll never closes an open list
  function fill(sel, list, value) {
    var c = choices(list), key = JSON.stringify([value, c.flight.map(function (e) { return e.label; }), c.finished.map(function (e) { return e.label; })]);
    if (sel.getAttribute("data-epk") === key) return sel;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    function opt(e) {
      var o = document.createElement("option");
      o.value = e.id; o.textContent = e.label; o.title = e.title;
      if (e.id === value) { o.selected = true; o.setAttribute("selected", ""); }
      return o;
    }
    function group(label, es) {
      if (!es.length) return;
      if (!c.flight.length || !c.finished.length) { es.forEach(function (e) { sel.appendChild(opt(e)); }); return; }
      var g = document.createElement("optgroup");
      g.setAttribute("label", label);
      es.forEach(function (e) { g.appendChild(opt(e)); });
      sel.appendChild(g);
    }
    group("In flight", c.flight);
    group("Finished", c.finished);
    sel.value = value;
    sel.setAttribute("data-epk", key);
    return sel;
  }
  // a new <select>: cls, id, label (its accessible name when no visible <label for> names it), onPick(id)
  function make(cfg) {
    var sel = document.createElement("select");
    if (cfg.cls) sel.className = cfg.cls;
    if (cfg.id) sel.setAttribute("id", cfg.id);
    if (cfg.label) sel.setAttribute("aria-label", cfg.label);
    sel.addEventListener("change", function () { if (cfg.onPick && sel.value) cfg.onPick(sel.value); });
    return sel;
  }
  return { choices: choices, preferred: preferred, fill: fill, make: make, fromDisplay: fromDisplay, fromId: fromId, word: word };
})();
