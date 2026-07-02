-- seed.sql -- GENERIC TEMPLATE (MSSQL / sqlcmd flavor). Adapt to your schema.
--
-- WHAT THIS IS: a worked pattern for seeding a precondition state directly in SQL so a
-- manual/QA test lands at its test point. Neutral example domain:
--     customers (ANCHOR, reused)  ->  orders (ROOT we create)  ->  order_lines (children)
-- Swap those three tables + their columns for yours. The PATTERN is the point, not the
-- example columns.
--
-- KEY RULES this template demonstrates:
--   1. Parameterize every knob at the top via sqlcmd -v -- NEVER edit the body per run.
--   2. Reuse a real ANCHOR row (do not fabricate owners/users).
--   3. Supply explicit ids (NEWID) so FKs can be wired in-script.
--   4. Enumerate columns explicitly (never INSERT ... SELECT * -- it breaks on temporal
--      / computed / identity columns).
--   5. Tag the root with a constant MARKER so cleanup.sql can find + delete the subtree.
--   6. Insert root-first, down the FK chain. Clean up leaf-first (see cleanup.sql).
--   7. Gate branch-only columns behind a knob + dynamic SQL so the script still runs on
--      the base schema.
--
-- Every $(knob) below MUST be supplied via -v (no defaults; copy the full command from
-- SKILL.md "How to run" and override only what your case needs).

SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;   -- required if any target table has a computed column
SET ANSI_NULLS ON;
BEGIN TRAN;

-- ---- KNOBS (all via -v) -----------------------------------------------------
DECLARE @EntityType       int          = $(EntityType);        -- 1 = variant A, 0 = variant B
DECLARE @StopAtStep       int          = $(StopAtStep);        -- 1 = root only, 2 = + children, 3 = + deeper layer
DECLARE @IncludeBranchCols bit         = $(IncludeBranchCols); -- 1 ONLY on a migrated-branch DB
DECLARE @Marker           nvarchar(20) = N'SEED-TEST';         -- cleanup tag; keep constant
DECLARE @EntityName       nvarchar(100)= N'$(EntityName)';
DECLARE @RefDate          date         = '$(RefDate)';
DECLARE @Amount           decimal(10,2)= $(Amount);            -- example parent-level value
DECLARE @Rate             decimal(8,4) = $(Rate);              -- example rate used in a derived value
DECLARE @ChildAmount      decimal(10,2)= $(ChildAmount);       -- example per-child value

-- ---- ANCHOR: reuse a real owner (no new customer/user) ----------------------
DECLARE @CustomerId uniqueidentifier;
SELECT TOP 1 @CustomerId = c.id FROM customers c ORDER BY c.created_at DESC;
IF @CustomerId IS NULL
    THROW 50001, 'No anchor row found -- seed base data first (app seed endpoint / DB restore).', 1;

DECLARE @DerivedTotal decimal(10,2) = ROUND(@Amount * (1 + @Rate), 2);

-- ---- STEP 1: ROOT (orders) --------------------------------------------------
DECLARE @OrderId uniqueidentifier = NEWID();
-- If (name, customer_id) is UNIQUE, uniquify so repeated seeds on one anchor don't
-- collide. Keep the @Marker prefix so cleanup's LIKE 'SEED-TEST%' still matches.
DECLARE @Reference nvarchar(120) =
    CONCAT(@Marker, N'-', LEFT(CONVERT(varchar(36), @OrderId), 8));
INSERT orders (id, reference, name, customer_id, entity_type, ref_date, amount, created_at, updated_at)
VALUES (@OrderId, @Reference, @EntityName, @CustomerId, @EntityType, @RefDate, @Amount,
        SYSUTCDATETIME(), SYSUTCDATETIME());

-- ---- STEP 2: children (order_lines) -----------------------------------------
IF @StopAtStep >= 2
BEGIN
    -- Two child rows. Variant A and B carry different columns off the same parent --
    -- mirror however your real variants differ.
    IF @EntityType = 1
        INSERT order_lines (id, order_id, description, unit_amount, derived_total, is_flagged)
        VALUES (NEWID(), @OrderId, N'Line A1', @ChildAmount, @DerivedTotal, 1),
               (NEWID(), @OrderId, N'Line A2', @ChildAmount, @DerivedTotal, 0);
    ELSE
        INSERT order_lines (id, order_id, description, unit_amount, derived_total, is_flagged)
        VALUES (NEWID(), @OrderId, N'Line B1', @ChildAmount, @DerivedTotal, 0),
               (NEWID(), @OrderId, N'Line B2', @ChildAmount, @DerivedTotal, 0);
END

-- ---- STEP 3: deeper layer with BRANCH-ONLY columns --------------------------
-- The extra columns exist only after the DB is migrated to the feature branch. Kept in
-- dynamic SQL so this script still COMPILES on the base schema; @IncludeBranchCols
-- toggles them.
IF @StopAtStep >= 3
BEGIN
    DECLARE @sql nvarchar(max) = N'
        INSERT order_line_adjustments (id, order_id, adjustment_amount'
        + CASE WHEN @IncludeBranchCols = 1 THEN N', branch_only_impact' ELSE N'' END
        + N')
        VALUES (NEWID(), @OrderId, 400.00'
        + CASE WHEN @IncludeBranchCols = 1 THEN N', @DerivedTotal - 400.00' ELSE N'' END
        + N');';
    EXEC sp_executesql @sql,
        N'@OrderId uniqueidentifier, @DerivedTotal decimal(10,2)',
        @OrderId = @OrderId, @DerivedTotal = @DerivedTotal;
END

-- ---- REPORT -----------------------------------------------------------------
PRINT 'Seeded order: ' + CONVERT(varchar(36), @OrderId)
    + ' (type=' + CAST(@EntityType AS varchar) + ', stopAtStep=' + CAST(@StopAtStep AS varchar) + ')';
SELECT CONVERT(varchar(36), @OrderId) AS OrderId,
       @EntityType AS EntityType,
       @StopAtStep AS StopAtStep,
       (SELECT COUNT(*) FROM order_lines WHERE order_id = @OrderId) AS Lines;

COMMIT;

-- CLEANUP: use cleanup.sql (subtree FKs are NOT cascade; computed cols need SET options).
