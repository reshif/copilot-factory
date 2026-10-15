function renderPicker() {
  $('#picker').innerHTML = Object.keys(RECIPES).map((id) => `<button type="button" data-r="${id}" aria-pressed="${id === recipe}">${id}</button>`).join('');
  $('#recipe-note').textContent = RECIPES[recipe].note;
  $('#picker').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    recipe = b.dataset.r;
    try { localStorage.setItem('fc-recipe', recipe); } catch (e) { /* ignore */ }
    stopRun();
    renderPicker();
    render();
    apply();
    if (selected && LAYOUT.nodes[selected]) select(selected); else showIntro();
  }));
}

// ===================================================================== live line: real jobs
