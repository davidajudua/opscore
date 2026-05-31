-- Per-pointer page state for the unified /dashboard panel. The panel now hosts
-- two views — 'totals' (default Today/Week/Month/All time grid) and 'history'
-- (last-8-days revenue grid) — and remembers which one each persistent
-- dashboard message was last flipped to so refreshDashboards re-renders the
-- correct page when a payment lands.
ALTER TABLE dashboard_pointer ADD COLUMN current_page TEXT NOT NULL DEFAULT 'totals';
