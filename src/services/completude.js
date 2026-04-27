/**
 * Completude grid — single source of truth for profile completeness.
 *
 * Total = 100 pts:
 *
 * Photos & Personnalité (75 pts)
 *   10 — Au moins 1 photo (profile_picture_url + photos[] cumulés)
 *    5 — 3 photos ou plus (cumul)
 *   10 — Bio / Pitch
 *   10 — Type de relation
 *    7 — Prompts (3 minimum, tout-ou-rien)
 *    5 — Passions (≥3 tags)
 *    3 — Taille
 *    3 — Langues
 *    3 — Signe astrologique
 *    3 — Niveau d'études
 *    5 — Projets familiaux
 *    5 — Style de communication
 *    6 — Langage d'amour
 *
 * Style de vie (25 pts)
 *    3 — Animal
 *    3 — Alcool
 *    3 — Tabac
 *    3 — Sport
 *    3 — Soirées
 *    3 — Week-ends
 *    2 — Réseaux sociaux
 *    2 — Poste
 *    1 — Entreprise
 *    2 — Chanson préférée
 *    (Genre et Lieu sont obligatoires à l'onboarding — pas de bonus)
 */

function totalPhotos(user) {
  const extra = Array.isArray(user.photos) ? user.photos.length : 0;
  return user.profile_picture_url ? extra + 1 : extra;
}

function buildItems(user, promptsCount = 0) {
  const photos = totalPhotos(user);

  return [
    // Photos
    { key: 'photo_1',             label: 'Au moins 1 photo',        pts: 10, done: photos >= 1 },
    { key: 'photo_3',             label: '3 photos ou plus',        pts: 5,  done: photos >= 3 },

    // Contenu narratif
    { key: 'bio',                 label: 'Pitch / Bio',             pts: 10, done: !!user.bio?.trim() },
    { key: 'relation_type',       label: 'Type de relation',        pts: 10, done: !!user.relation_type },
    { key: 'prompts',             label: 'Prompts (3 minimum)',     pts: 7,  done: promptsCount >= 3 },
    { key: 'tags',                label: 'Passions (3 minimum)',    pts: 5,  done: (user.tags?.length ?? 0) >= 3 },

    // Profil étendu
    { key: 'height_cm',           label: 'Taille',                  pts: 3,  done: !!user.height_cm && user.height_cm > 0 },
    { key: 'languages',           label: 'Langues',                 pts: 3,  done: (user.languages?.length ?? 0) > 0 },
    { key: 'astro_sign',          label: 'Signe astrologique',      pts: 3,  done: !!user.astro_sign },
    { key: 'education',           label: "Niveau d'études",         pts: 3,  done: !!user.education },
    { key: 'family_plans',        label: 'Projets familiaux',       pts: 5,  done: !!user.family_plans },
    { key: 'communication_style', label: 'Style de communication',  pts: 5,  done: !!user.communication_style },
    { key: 'love_language',       label: "Langage d'amour",         pts: 6,  done: !!user.love_language },

    // Style de vie
    { key: 'pet',                 label: 'Animal de compagnie',     pts: 3,  done: !!user.pet },
    { key: 'alcohol',             label: 'Alcool',                  pts: 3,  done: !!user.alcohol },
    { key: 'tobacco',             label: 'Tabac',                   pts: 3,  done: !!user.tobacco },
    { key: 'sport',               label: 'Sport',                   pts: 3,  done: !!user.sport },
    { key: 'evenings_type',       label: 'Soirées',                 pts: 3,  done: !!user.evenings_type },
    { key: 'weekends_type',       label: 'Week-ends',               pts: 3,  done: !!user.weekends_type },
    { key: 'social_media',        label: 'Réseaux sociaux',         pts: 2,  done: !!user.social_media },
    { key: 'job_title',           label: 'Poste',                   pts: 2,  done: !!user.job_title },
    { key: 'company',             label: 'Entreprise',              pts: 1,  done: !!user.company },
    { key: 'favorite_song',       label: 'Chanson préférée',        pts: 2,  done: !!user.favorite_song },
  ];
}

/**
 * calculateCompletude(user, promptsCount)
 *
 * Returns the completeness percentage (0–100) for the given user.
 * promptsCount is the number of answered prompts (used for the "3 minimum"
 * threshold, worth 7 pts in tout-ou-rien). Defaults to 0 if omitted.
 */
function calculateCompletude(user, promptsCount = 0) {
  const total = buildItems(user, promptsCount)
    .reduce((sum, item) => sum + (item.done ? item.pts : 0), 0);
  return Math.min(100, total);
}

/**
 * completudeBreakdown(user, promptsCount)
 *
 * Returns { pct, items: [{ key, label, pts, done }, ...] } — the full grid
 * exposed via GET /api/users/me/completude so the frontend renders the
 * detail screen as a pure consumer (no local recomputation).
 */
function completudeBreakdown(user, promptsCount = 0) {
  const items = buildItems(user, promptsCount);
  const pct   = Math.min(100, items.reduce((sum, i) => sum + (i.done ? i.pts : 0), 0));
  return { pct, items };
}

module.exports = { calculateCompletude, completudeBreakdown };
