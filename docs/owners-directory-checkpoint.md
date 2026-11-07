# Owners directory — 2026-11-07

The owners landing page is now a compact directory, with desktop columns for identity, contacts, pets and actions, and stacked mobile rows. The existing globalSearch node moves from the header to the directory; its ID, listeners, clear control and routing behavior are retained. Existing filter and sort state is reused. The new presentation adapter returns before the hidden legacy table is built, with fallback retained if the adapter is unavailable.

Owners without phone/email/Telegram receive one missing-contact status. Empty address/contact placeholders are omitted. Existing notes are shown under the name, truncated with a full tooltip. Pet names are shown without clipped breed text; full details remain in the tooltip and owner profile. A matching pet is promoted to the visible first two results. User-entered values are escaped.

Existing delegated commands handle add, open, edit, phone copying and deletion confirmation. The detailed owner profile and owner editor are unchanged. No API or database changes.

The directory uses the existing calendar palette tokens for Pearl, PUG, Graphite/gold, Eucalyptus and blue. Route-scoped background styling stops on leaving the owners page.

Validation: JavaScript syntax and Flask public-asset allowlist tests; isolated browser fixture executes actual owners renderer, original input/filter/sort and delegated click handlers. Verified search by name/phone/pet/breed, filter counts, sorting, matching third pet visibility, escaped hostile values, keyboard open, menu Escape, edit/add dispatch, phone copy dispatch, deletion confirmation, empty and filtered-empty states, four interface languages, five palettes and mobile width. Live clinic records were not modified by testing.
