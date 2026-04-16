/**
 * calculateCompletude(user)
 *
 * Returns a profile completeness score from 0 to 100.
 * Called every time a user updates their profile (PATCH /users/me).
 *
 * Scoring breakdown — total 100 pts:
 *
 * PHOTOS & PERSONNALITÉ (62 pts)
 *   10 — Au moins 1 photo
 *    5 — 3 photos ou plus
 *   10 — Bio / Pitch
 *   10 — Type de relation
 *    5 — Passions (min 3 tags)
 *    3 — Taille
 *    3 — Langues
 *    3 — Signe astrologique
 *    3 — Niveau d'études
 *    5 — Projets familiaux
 *    5 — Style de communication
 *    6 — Langage d'amour (le plus lourd : déterminant pour la compatibilité)
 *
 * STYLE DE VIE (38 pts)
 *    3 — Animal de compagnie
 *    3 — Alcool
 *    3 — Tabac
 *    3 — Sport
 *    2 — Réseaux sociaux
 *    3 — Soirées
 *    3 — Week-ends
 *    2 — Poste
 *    1 — Entreprise
 *    2 — Lieu de résidence
 *    2 — Chanson préférée
 *    5 — Genre
 */
function calculateCompletude(user) {
  let pts = 0;

  // ── Photos & Personnalité ──────────────────────────────────────────────────
  const extraPhotos  = Array.isArray(user.photos) ? user.photos.length : 0;
  const totalPhotos  = user.profile_picture_url ? extraPhotos + 1 : extraPhotos;

  if (totalPhotos >= 1) pts += 10;   // Au moins 1 photo
  if (totalPhotos >= 3) pts += 5;    // 3 photos ou plus

  if (user.bio?.trim())                        pts += 10;  // Bio / Pitch
  if (user.relation_type)                      pts += 10;  // Type de relation
  if ((user.tags?.length ?? 0) >= 3)           pts += 5;   // Passions (min 3)
  if (user.height_cm)                          pts += 3;   // Taille
  if (user.languages?.length)                  pts += 3;   // Langues
  if (user.astro_sign)                         pts += 3;   // Signe astrologique
  if (user.education)                          pts += 3;   // Niveau d'études
  if (user.family_plans)                       pts += 5;   // Projets familiaux
  if (user.communication_style)                pts += 5;   // Style de communication
  if (user.love_language)                      pts += 6;   // Langage d'amour

  // ── Style de vie ──────────────────────────────────────────────────────────
  if (user.pet)            pts += 3;  // Animal de compagnie
  if (user.alcohol)        pts += 3;  // Alcool
  if (user.tobacco)        pts += 3;  // Tabac
  if (user.sport)          pts += 3;  // Sport
  if (user.social_media)   pts += 2;  // Réseaux sociaux
  if (user.evenings_type)  pts += 3;  // Soirées
  if (user.weekends_type)  pts += 3;  // Week-ends
  if (user.job_title)      pts += 2;  // Poste
  if (user.company)        pts += 1;  // Entreprise
  if (user.city)           pts += 2;  // Lieu de résidence
  if (user.favorite_song)  pts += 2;  // Chanson préférée
  if (user.gender)         pts += 5;  // Genre

  return Math.min(100, pts);
}

/**
 * completudeBreakdown(user)
 *
 * Returns the same total plus an itemised list — useful for debug or
 * the "complete your profile" screen in the app.
 */
function completudeBreakdown(user) {
  const extraPhotos = Array.isArray(user.photos) ? user.photos.length : 0;
  const totalPhotos = user.profile_picture_url ? extraPhotos + 1 : extraPhotos;

  const items = [
    { label: 'Au moins 1 photo',       pts: 10, done: totalPhotos >= 1 },
    { label: '3 photos ou plus',        pts: 5,  done: totalPhotos >= 3 },
    { label: 'Bio / Pitch',             pts: 10, done: !!user.bio?.trim() },
    { label: 'Type de relation',        pts: 10, done: !!user.relation_type },
    { label: 'Passions (min 3)',         pts: 5,  done: (user.tags?.length ?? 0) >= 3 },
    { label: 'Taille',                  pts: 3,  done: !!user.height_cm },
    { label: 'Langues',                 pts: 3,  done: !!user.languages?.length },
    { label: 'Signe astrologique',      pts: 3,  done: !!user.astro_sign },
    { label: "Niveau d'études",         pts: 3,  done: !!user.education },
    { label: 'Projets familiaux',       pts: 5,  done: !!user.family_plans },
    { label: 'Style de communication',  pts: 5,  done: !!user.communication_style },
    { label: "Langage d'amour",         pts: 6,  done: !!user.love_language },
    { label: 'Animal de compagnie',     pts: 3,  done: !!user.pet },
    { label: 'Alcool',                  pts: 3,  done: !!user.alcohol },
    { label: 'Tabac',                   pts: 3,  done: !!user.tobacco },
    { label: 'Sport',                   pts: 3,  done: !!user.sport },
    { label: 'Réseaux sociaux',         pts: 2,  done: !!user.social_media },
    { label: 'Soirées',                 pts: 3,  done: !!user.evenings_type },
    { label: 'Week-ends',               pts: 3,  done: !!user.weekends_type },
    { label: 'Poste',                   pts: 2,  done: !!user.job_title },
    { label: 'Entreprise',              pts: 1,  done: !!user.company },
    { label: 'Lieu de résidence',       pts: 2,  done: !!user.city },
    { label: 'Chanson préférée',        pts: 2,  done: !!user.favorite_song },
    { label: 'Genre',                   pts: 5,  done: !!user.gender },
  ];

  const total = items.reduce((sum, i) => sum + (i.done ? i.pts : 0), 0);
  return { total: Math.min(100, total), items };
}

module.exports = { calculateCompletude, completudeBreakdown };
