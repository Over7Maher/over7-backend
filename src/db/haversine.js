/**
 * haversineSQL(latParam, lngParam, alias)
 *
 * Returns a SQL fragment that computes the great-circle distance in km
 * between a fixed point (latParam, lngParam) and a row's coordinates
 * (alias.latitude, alias.longitude).
 *
 * latParam / lngParam are SQL parameter placeholders, e.g. '$9', '$10'.
 * alias is the table alias used in the query, e.g. 'u' or 'other'.
 *
 * Returns NULL whenever either coordinate set is NULL (no PostGIS needed).
 */
function haversineSQL(latParam, lngParam, alias = 'u') {
  return `
    (6371 * 2 * ASIN(
      SQRT(
        POWER(SIN(RADIANS(${latParam} - ${alias}.latitude)  / 2), 2) +
        COS(RADIANS(${latParam})) * COS(RADIANS(${alias}.latitude)) *
        POWER(SIN(RADIANS(${lngParam} - ${alias}.longitude) / 2), 2)
      )
    ))::INT
  `;
}

module.exports = haversineSQL;
