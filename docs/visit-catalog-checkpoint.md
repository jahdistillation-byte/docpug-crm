# Unified visit service and stock selection — 2026-11-08

One theme-aware modal now selects services and stock items. The original hidden select IDs and add buttons remain the inputs to the existing visit mutation handlers. Selection fills the existing control and focuses quantity; it does not create a charge or write off stock until the original Add action is used. Initial implicit selection of the first catalog item is removed and Add is disabled until an explicit valid selection.

Search normalizes case, accents and apostrophes, matches all query words in any order, and includes the existing category, category label, code, SKU, barcode, manufacturer and stock unit. Compact code forms match hyphenated codes. Mechanical Latin/Ukrainian keyboard-layout variants are supported; no pharmacological synonym or approximate drug substitution is inferred. Exact names and prefixes rank before broader matches. Inactive items are excluded. Existing categories are displayed without editing catalog data; redundant Other labels are suppressed when the catalog is uncategorized.

Stock rows show unit price and available quantity. Out-of-stock items are hidden by default and can be shown as disabled reference rows. A previously selected item that becomes unavailable is cleared rather than silently replaced with another item. Actual stock sufficiency and billing remain enforced by the existing add APIs.

Keyboard navigation, Escape, focus restoration, dialog focus containment, empty/reset states, zero-price services, escaped catalog names and visit-context isolation are included. Opening another picker closes the previous dialog and listeners. The modal follows all five PUG palettes and uses SVG icons.

The medical-draft snapshot now includes the full clinical fields and home-treatment rows. Service/stock mutations previously restored only five legacy fields; newly written reason, examination or diagnostic-plan text could otherwise be reset by visit rerendering. The update preserves those drafts without changing their save format.

Validation: four Node search tests; JavaScript syntax and static public asset security checks; browser fixture using real visit add handlers with stubbed APIs, covering service/stock selection, quantities, remaining-stock preview, categories, keyboard selection, disabled zero-stock rows, zero-price selection, empty states, escaping, repeated dialogs, visit switching, medical-draft preservation and final clinical-save payloads across five themes and mobile layouts. No live clinic data was modified. No database migration required.
