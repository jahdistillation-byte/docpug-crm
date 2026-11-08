# Clinical visit workspace — 2026-11-08

This change targets the opened visit screen, rather than the patient's visit-history list.

The existing clinical fields are organized into three cards: examination/history, assessment/diagnosis, and treatment/owner recommendations. DOM nodes are moved rather than recreated, preserving values, IDs and event handlers. The original medical save, service/stock mutations, payment, PDF and completion implementations remain in place. The services navigation target now points to the visible service card instead of the hidden search input.

On desktop, the invoice and primary actions occupy a sticky right sidebar. The former horizontal summary layout is explicitly reset. On phones the summary follows the form, with a compact fixed action bar forwarding save clicks to the original save button and invoice clicks to the original finish navigation. Duplicate IDs are not introduced. Summary amounts continue to come from the existing finance renderer.

PUG AI is available through an expandable panel. Its existing intake and consultant tabs, fields and handlers are retained. The consultant appears inline within this panel. The panel can be expanded through the existing consultant launcher as well. The initial patient overview is less crowded. Stored visit status is reflected in the header, including visits that return early from the original completed-visit rendering path.

Styles use the shared five-theme PUG palette, custom SVG icons and responsive layouts. Historical visit weight remains the weight recorded for that visit.

Validation:
- JavaScript syntax and static public asset security tests pass.
- A browser fixture runs the real renderVisitPage, initVisitUI, AI workspace mounting and home-treatment functions with synthetic records and stubbed external APIs. It checks field values after reorganization, stage navigation, AI tab switching and draft text preservation, prescription addition, actual medical-save request payloads, payment action binding, PDF handler binding, completion confirmation, completed status, repeated rendering without duplicate panels, five themes and phone overflow (including a populated prescription).
- Screenshots reviewed for the clinical form, sidebar, mobile layout and expanded AI panes. No live clinic records, payments or prescriptions were changed by these checks.

No database migration is required.


## Follow-up fixes — active route and wider workspace

- Reset the legacy summary-card translateX and inset styles, which were applied only to the active visit route on wide screens. Sidebar geometry is now verified with the real app-container/main-content wrapper and active page class at 1500, 1710, 1920 and 2560 pixels.
- Exclude the sticky desktop invoice from automatic scroll-stage detection. Stage buttons target whole clinical cards. Explicit navigation retains its selection during smooth scrolling; wheel/touch/keyboard navigation restores automatic tracking. The finish button emphasizes the already visible pinned invoice without scrolling the document unexpectedly.
- Increase the canvas to 1760 pixels and disable legacy 80% scaling only on the visit route, improving field width and text readability.
- Distinguish the owner discharge plan with an accent surface, left border, document badge and more room for recommendations. Clinical values and their save handlers are unchanged.
- Regression fixture now uses an active route, including completed-visit navigation and repeated clicks across Diagnosis, Treatment and Services rather than only testing the inactive DOM.
