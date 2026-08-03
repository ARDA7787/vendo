/**
 * Make everything BEHIND a body-level Vendo surface inert, and put it back.
 *
 * Both of the surfaces that escape to `document.body` need this: the overlay
 * panel (a modal dialog) and the mobile takeover page (which covers the host's
 * viewport whole). `position: fixed` plus a scrim stops the mouse; only `inert`
 * stops the keyboard and the screen reader from walking into the host page
 * underneath a surface that is visually covering it.
 *
 * Returns the release function — call it on close AND on unmount-while-open.
 */
export function inertBehind(wrapper: Element | null): () => void {
  const { body } = document;
  const inerted: Element[] = [];
  const inert = (child: Element) => {
    if (child === wrapper || child.tagName === "SCRIPT" || child.tagName === "STYLE" || child.hasAttribute("inert")) return;
    // Never inert another modal surface: the overlay (or the palette's takeover
    // portal) can mount above this one and must stay interactive — an inert
    // ancestor would freeze the whole dialog.
    if (child.matches('[aria-modal="true"]') || child.querySelector('[aria-modal="true"]')) return;
    child.setAttribute("inert", "");
    inerted.push(child);
  };
  for (const child of Array.from(body.children)) inert(child);
  // ENG-228: body children can also appear WHILE the surface is up — the
  // page/palette takeover portals mount on a breakpoint flip, hosts mint toast
  // portals. The open-time snapshot alone would leave those interactive behind
  // the surface, so keep watching.
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.parentElement === body) inert(node);
      }
    }
  });
  observer.observe(body, { childList: true });
  return () => {
    observer.disconnect();
    for (const element of inerted) element.removeAttribute("inert");
  };
}
