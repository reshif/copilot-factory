function markSeen(id) {
  const m = MODELS.get(id);
  if (!m) return;
  SEEN[id] = m.rev;
  store.set('fc-seen', JSON.stringify(SEEN));
}
function seedSeen() {
  let changed = false;
  for (const m of MODELS.values()) if (!SEEN[m.id]) { SEEN[m.id] = m.rev; changed = true; }
  if (changed) store.set('fc-seen', JSON.stringify(SEEN));
}

// ---------- toasts and notifications
