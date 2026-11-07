# Calendar workspace — 2026-11-07

Implemented a compact calendar presentation and appointment form in the main white theme.

- Day: quieter toolbar, clinician headers, keyboard access, expandable appointments without a matching visible staff column.
- Week: compact date headings and event cards, counts, removal of repeated reason text.
- Month: full-width schedule, details drawer only when opened, complete staff list.
- Booking: existing patient search and quick creation, templates, date/time/duration/staff/reason controls retained. Selected patient summary, end-time summary, advisory live availability checks added. Existing save validation and override prompts remain authoritative.
- Full-day schedule hides the irrelevant end-time input; existing next-day explanation remains.
- New UI icons use the shared SVG system. No database changes.

Validation: JavaScript syntax checks pass. Local browser fixture exercises actual calendar renderer, appointment opener and save handler with isolated API data. Passed day/week/month navigation, unassigned appointment escaping and opening, schedule drawer, full-day end input, appointment prefill/patient search/save payload, collision confirmation, off-shift and failed-read feedback, quick patient fields and mobile width. Desktop and mobile time-axis alignment checked geometrically. No live clinic records were created or altered during these checks.

Deployment: calendar assets included in the public asset allowlist; deployment verification pending.
