// The module tabs' two menus (連絡・運営, 2026-11-23) on the rental screens (index.html, supplies.html). Works like the
// common screens' tabs (src/client/components/AppShell.tsx, GlobalNav): a button shows and hides its list of links;
// a press beside the open menu, Esc or tabbing past it closes it. Esc puts the focus back on the button.
(() => {
  const nav = document.querySelector('.global-nav');
  if (!nav) return;
  // Under the tabs and over the page while a menu is open, so the press that closes it does nothing else.
  const scrim = document.createElement('div');
  scrim.className = 'nav-scrim';
  scrim.hidden = true;
  scrim.setAttribute('aria-hidden', 'true');
  nav.append(scrim);

  let open = null;
  const menuOf = (toggle) => document.getElementById(toggle.getAttribute('aria-controls'));
  const close = (focus) => {
    if (!open) return;
    const toggle = open;
    open = null;
    toggle.setAttribute('aria-expanded', 'false');
    menuOf(toggle).hidden = true;
    scrim.hidden = true;
    if (focus) toggle.focus();
  };
  const show = (toggle) => {
    close(false);
    open = toggle;
    toggle.setAttribute('aria-expanded', 'true');
    menuOf(toggle).hidden = false;
    scrim.hidden = false;
  };

  nav.addEventListener('click', (e) => {
    const toggle = e.target.closest('.nav-group-toggle');
    if (toggle) {
      if (open === toggle) close(false);
      else show(toggle);
      return;
    }
    if (e.target.closest('.nav-menu a')) close(false);
  });
  scrim.addEventListener('click', () => close(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) close(true);
  });
  nav.addEventListener('focusout', (e) => {
    const next = e.relatedTarget;
    if (open && next instanceof Node && !open.closest('.nav-group').contains(next)) close(false);
  });
})();
