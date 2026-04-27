// Columns exposed on profile responses (never return raw rows).
// Shared between users.js, prompts.js, and any other route that returns
// the current user (e.g. after a state-changing action).
function formatUser(row) {
  return {
    id:                  row.id,
    email:               row.email,
    name:                row.name,
    birth_date:          row.birth_date,
    city:                row.city,
    bio:                 row.bio,
    profile_picture_url: row.profile_picture_url,
    photos:              row.photos,
    tags:                row.tags,

    // Dating preferences
    relation_type:       row.relation_type,
    family_plans:        row.family_plans,
    communication_style: row.communication_style,
    love_language:       row.love_language,

    // Identity & lifestyle
    gender:              row.gender,
    height_cm:           row.height_cm,
    languages:           row.languages,
    astro_sign:          row.astro_sign,
    education:           row.education,
    job_title:           row.job_title,
    company:             row.company,
    pet:                 row.pet,
    alcohol:             row.alcohol,
    tobacco:             row.tobacco,
    sport:               row.sport,
    social_media:        row.social_media,
    evenings_type:       row.evenings_type,
    weekends_type:       row.weekends_type,
    favorite_song:       row.favorite_song,

    // Matching preferences
    seeking:             row.seeking,
    age_min:             row.age_min,
    age_max:             row.age_max,
    distance_max:        row.distance_max,

    // Scores & pool
    completude_pct:          row.completude_pct,
    arena_votes_given:       row.arena_votes_given,
    is_in_pool:              row.is_in_pool,
    avg_rating:              row.avg_rating,
    pool_unlocked_pending:   row.pool_unlocked_pending,
    pool_unlocked_at:        row.pool_unlocked_at,
    arena_intro_seen:        row.arena_intro_seen,

    notification_preferences: row.notification_preferences,

    created_at:              row.created_at,
  };
}

module.exports = formatUser;
