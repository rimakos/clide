-- cleanup.sql -- GENERIC TEMPLATE. Removes ALL rows tagged 'SEED-TEST' by seed.sql.
--
-- WHY A SCRIPT (not a one-liner): subtree FKs are typically NOT ON DELETE CASCADE, so a
-- bare `DELETE FROM orders` fails (Msg 547). Delete children LEAF-FIRST, up the FK chain,
-- then the root. If any target has a computed column, QUOTED_IDENTIFIER must be ON
-- (else Msg 1934) -- so run this via -i (this file sets the option), NOT as a bare -Q.
--
--   SQLCMDPASSWORD='<db-password>' sqlcmd -S localhost,1433 -U sa -d <database> -C \
--     -i ~/.claude/skills/seed-test-data/cleanup.sql
--
-- Mirror YOUR FK chain here (this example matches seed.sql: orders -> order_lines and
-- order_line_adjustments). Delete every child table before its parent.

SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET XACT_ABORT ON;
BEGIN TRAN;

-- Collect the seeded roots once, by the constant marker.
DECLARE @roots TABLE (id uniqueidentifier);
INSERT @roots SELECT id FROM orders WHERE reference LIKE 'SEED-TEST%';
DECLARE @n int = (SELECT COUNT(*) FROM @roots);

-- Deepest children first ...
DELETE a FROM order_line_adjustments a
  WHERE a.order_id IN (SELECT id FROM @roots);

DELETE l FROM order_lines l
  WHERE l.order_id IN (SELECT id FROM @roots);

-- ... then the root.
DELETE FROM orders WHERE id IN (SELECT id FROM @roots);

PRINT 'Deleted SEED-TEST orders: ' + CAST(@n AS varchar);
COMMIT;
