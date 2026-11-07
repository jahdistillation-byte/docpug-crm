# Calendar background synchronization

The existing 30-second waiting-patient poll no longer calls the foreground calendar renderer unconditionally.

- Unchanged appointment data leaves the DOM intact (fingerprint independent of row/key ordering).
- Changed day/week data reuses the poll response and refreshes without a loading placeholder; scroll, selected mobile clinician, outside-column expansion and focus are retained.
- Open appointment dialogs, date picker and schedule controls defer calendar refresh until a subsequent poll. Month is a staff schedule rather than an appointment view and is not rebuilt by this appointment poll.
- Hidden tabs skip polling; overlapping polls are prevented and the busy guard resets on failure.
- Render revision plus route/date/mode guards discard outdated background results.
- API failures leave the current calendar visible. Existing notification and save logic is retained.

Validation: JavaScript syntax check and isolated browser checks against the actual renderer, appointment opener and save handler. Verified unchanged DOM identity, new appointment visibility, no loading placeholder, retained scroll, open form preservation and stale response after navigation. Existing booking, collision, off-shift, vaccination and responsive checks pass. No database changes.
