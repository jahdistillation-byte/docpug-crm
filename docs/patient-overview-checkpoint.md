# Patient overview — 2026-11-08

The overview uses the approved PUG theme palette in all five themes. Main column: diagnoses, weight measurements and chart, vaccinations, collapsed AI summary. Side column: passport and physician notes. At narrow widths the columns stack and navigation scrolls horizontally. Existing clinical controls are moved with their DOM nodes before their original handlers are bound. Secondary diagnosis status actions live in a disclosure; important statuses retain their text labels.

Weight now uses one chronological source in the header, passport and weight panel. Measurements sort by measured_at, falling back to created_at, with created_at as the tie breaker. This fixes retrospective entries being treated as current measurements. The profile weight remains the fallback when there is no valid history. No records are rewritten. Weight history is fetched on every patient tab so the header stays consistent when navigating between tabs. A failed weight request retains the existing error behavior.

The chart shows up to twelve recent actual measurements with dates and the observed value range. The first three history rows are visible and remaining records expand. Weight change is neutral in color and is not presented as a clinical improvement or deterioration. The AI summary implementation is unchanged and is available in a native expandable panel.

Validation:
- Node weight presentation tests cover retrospective entry ordering, time zones, ties, invalid values, immutable sorting and fallback.
- Browser fixture exercises the real render and binding functions with synthetic records: five themes, mobile overflow, notes saving, new measurement refresh, navigation, diagnosis actions, vaccine actions, AI summary and empty/role states. No live clinic records modified.
- JavaScript syntax and static public asset security checks pass.

Scope: patient header and Overview tab. Other tab bodies and clinical editors retain their current implementation. No database migration, finance changes or Checkbox integration.
