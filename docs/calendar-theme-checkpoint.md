# Calendar themes — 2026-11-07

Workflow agreed with Tim: complete and verify a section's behavior first, then finish its appearance across clinic themes.

Calendar now has a scoped palette adapter (calendar-themes.css), loaded after calendar-workspace.css. Existing theme IDs are unchanged: purple is displayed as PUG, black remains Graphite with warm gold accents, green Eucalyptus, blue and white retain their identities. PUG uses a quiet graphite/plum environment and saturated brand violet primary buttons.

The adapter covers day/week/month, appointment creation and patient search, vaccination fields, shift editor, date picker, event editor and template surfaces. Shared geometry and existing commands are retained; no database changes. Body background/accent overrides apply only while the calendar route is active. Other modules retain their current styling. A repeated booking root ID is intentional because legacy selector lists elsewhere contain two IDs.

Validation: local browser fixtures using the real calendar renderer, booking and shift save handlers. Five palettes checked across calendar modes and form surfaces, primary/field contrast >=4.5, mobile width checked. Existing booking save, collision and off-shift guards, vaccination fields, regular/24-hour shift saves, retry and quiet refresh checks pass. Flask public asset allowlist tests include the new CSS file.
