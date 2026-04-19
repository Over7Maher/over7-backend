/**
 * Returns a SQL NOT EXISTS fragment that excludes rows where either party
 * has blocked the other. Safe to embed in any WHERE clause.
 *
 * @param {string} currentUserParam - SQL placeholder for current user id (e.g. '$1')
 * @param {string} targetAlias      - SQL table alias for the other user (e.g. 'u')
 */
function notBlockedClause(currentUserParam, targetAlias) {
  return `NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE (b.blocker_id = ${currentUserParam} AND b.blocked_id = ${targetAlias}.id)
       OR (b.blocker_id = ${targetAlias}.id  AND b.blocked_id = ${currentUserParam})
  )`;
}

module.exports = { notBlockedClause };
