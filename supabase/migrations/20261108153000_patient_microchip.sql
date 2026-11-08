-- Optional identifier; text preserves leading zeroes and legacy formats.
BEGIN;
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS microchip_number text;
COMMENT ON COLUMN public.patients.microchip_number IS
  'Optional pet microchip identifier, preserved as text.';
COMMIT;
