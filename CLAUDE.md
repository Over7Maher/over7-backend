# Over7 Backend — Guide Claude Code

## 🎯 Vue d'ensemble du projet

Over7 = application de rencontre React Native (frontend séparé) avec backend Node/Express déployé sur Railway.

Particularité : l'utilisateur Amin (Maher Karoui) N'EST PAS développeur. Il pilote Claude Code via copier-coller de briefs structurés. Le projet a été modernisé sur Sessions 24+25+25bis (29 avril 2026) avec 25 commits, 25/25 CI verts, 0 régression.

## 👤 Conventions de communication avec Amin

CRITIQUES À RESPECTER :

1. **Préfixe obligatoire** : 🔧 Backend ou 📱 Frontend devant chaque brief
2. **Langage simple, en français** (Amin n'est pas dev)
3. **Briefs structurés copier-collables** (étape par étape, attendus précis)
4. **Captures écran encouragées** pour UI/Railway/GitHub
5. **Choix multiples avec recos claires** (A/B/C, pas de question ouverte)
6. **Pauses obligatoires 10 min** avant chaque chantier risqué (auth, frameworks majeurs)
7. **Test E2E manuel obligatoire** après chaque chantier critique
8. **Plan de rollback documenté** avant chaque push
9. **STOP immédiat au premier signal louche**
10. **Audit avant implémentation** sur les bumps risqués (GO / GO RÉSERVES / NO-GO)
11. **NEVER bricoler après un refus** : si Amin dit NO-GO, on reporte sans insister
12. **Encourager les pauses** : refuser de continuer si fatigue cognitive observée

## 🏗️ Stack technique

- **Runtime** : Node.js 22 LTS (CI + Railway)
- **Framework** : Express 5.2.1
- **Database** : PostgreSQL (Railway-managed)
- **Auth** : Firebase Auth (firebase-admin 13.8.0) — verifyIdToken pattern
- **Storage photos** : Cloudinary
- **WebSocket** : Socket.io
- **Tests** : Jest 30 + supertest 7 + jest-circus
- **Lint** : ESLint 10 + Prettier (manuel, pas en CI yet)
- **Coverage** : Codecov (83.52% lines, 73% branches)
- **CI/CD** : GitHub Actions → Railway auto-deploy

## 📁 Structure du projet

```
backend/
├── .github/workflows/test.yml    # CI GitHub Actions
├── src/
│   ├── app.js                    # Express setup + middlewares
│   ├── db/
│   │   ├── pool.js               # PostgreSQL pool singleton
│   │   └── schema.sql            # DB schema (lecture seule)
│   ├── middleware/
│   │   ├── auth.js               # Firebase ID token verifier
│   │   ├── errorHandler.js       # Catch-all error middleware
│   │   └── multerErrorHandler.js # MulterError → 400/413 proper
│   ├── routes/
│   │   ├── users.js              # /api/users/*
│   │   ├── arena.js              # /api/arena/* (rating system)
│   │   ├── likes.js              # /api/likes/* + super-likes
│   │   ├── discover.js           # /api/discover/* (browse profiles)
│   │   ├── matches.js            # /api/matches/*
│   │   ├── messages.js           # /api/messages/*
│   │   ├── prompts.js            # /api/prompts/*
│   │   ├── upload.js             # /api/upload/* (Multer + Cloudinary)
│   │   ├── reports.js            # /api/reports/*
│   │   ├── blocks.js             # /api/blocks/*
│   │   ├── speedDate.js          # /api/speed-date/*
│   │   ├── bug-reports.js        # /api/bug-reports/*
│   │   └── __tests__/            # 259 tests Jest supertest
│   ├── services/
│   │   ├── firebaseAdmin.js      # Firebase Admin SDK init
│   │   ├── cloudinary.js         # uploadPhoto, deletePhotos
│   │   └── socket.js             # Socket.io server + room emit
│   ├── jobs/
│   │   ├── purgeExpiredAccounts.js  # Cron RGPD 02:30 UTC
│   │   └── scheduler.js          # node-cron schedule
│   └── utils/
│       └── slots.js              # Speed-date timezone helpers
├── eslint.config.js              # ESLint flat config v10
├── .prettierrc.json
├── .prettierignore
├── package.json
└── railway.json                  # preDeployCommand: db:migrate
```

## 🚀 Commandes courantes

```bash
# Tests
npm test                          # Run all 259 tests
npm test -- <fichier>             # Run un fichier spécifique
npm run test:coverage             # Coverage report (Codecov)
npm run test:watch                # Watch mode

# Code quality
npm run lint                      # ESLint check (0 erreur, 3 warnings cosmétiques attendus)
npm run lint:fix                  # ESLint auto-fix
npm run format:check              # Prettier check (49 fichiers à reformater — pas auto-formaté volontairement)
npm run format                    # Prettier write (NE PAS LANCER sauf décision Amin)

# Dev local
node src/app.js                   # Boot serveur sur port 3000

# DB migration (preDeployCommand Railway)
npm run db:migrate                # psql $DATABASE_URL -f src/db/schema.sql
```

## 🧪 Patterns de tests Jest critiques

CRITIQUE : utiliser `jest.resetAllMocks()` PAS `jest.clearAllMocks()` (clearAllMocks ne purge PAS les mockResolvedValueOnce queues).

```javascript
// Pool mock avec connect (transactions)
jest.mock('../../db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));

// firebase-admin chainable mock
jest.mock('../../services/firebaseAdmin', () => () => ({
  auth: () => ({ verifyIdToken: mockFn })
}));

// socket.io capture room
const mockEmitToRoom = jest.fn();
jest.mock('../../services/socket', () => () => ({
  to: (room) => ({ emit: (e, p) => mockEmitToRoom(room, e, p) }),
}));

// mockClient helper (transactions)
function mockClient() {
  const client = { query: jest.fn(), release: jest.fn() };
  pool.connect.mockResolvedValueOnce(client);
  return client;
}

// Auth helper
function mockAuthOk() {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: ACTIVE_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [ACTIVE_USER] });
}

// resetAllMocks systématique
beforeEach(() => jest.resetAllMocks());

// supertest.attach() pour multer
await request(app).post('/api/upload/photo')
  .set('Authorization', 'Bearer valid-token')
  .attach('photo', Buffer.from('fake'), 'test.jpg');
```

## 🎓 Apprentissages techniques importants

- **UUIDs all-2s/all-1s rejetés par isUUID()** : utiliser de vrais UUIDs v4
- **omit=optional dans .npmrc** : skip jest-circus → déclarer en devDep explicite
- **Express 5 req.query immutable** : `.toInt()` d'express-validator ne mute plus → parseInt explicite
- **Express 5 req.body undefined sans Content-Type** : mitigation middleware `req.body ??= {}`
- **TIMESTAMPTZ partout en DB** : jamais de timezone locale
- **edgeToEdgeEnabled:true (Expo SDK 54)** : neutralise windowSoftInputMode Android côté frontend
- **require.main === module guard** : permet d'exporter app pour supertest
- **4G/Wi-Fi conflict téléphone** : IP qui commence par 100.x.x.x = CGNAT mobile

## 🔑 Comptes & URLs (sans secrets)

- **GitHub** : https://github.com/Over7Maher/over7-backend
- **Railway** : project "determined-illumination", service "over7-backend"
- **Railway URL prod** : https://over7-backend-production.up.railway.app
- **Codecov** : https://app.codecov.io/gh/Over7Maher/over7-backend
- **Firebase project** : over7-d9653
- **Resend** : domaine over7.app vérifié (region eu-west-1)

## 🔐 Variables d'environnement Railway

```
DATABASE_URL                      # PostgreSQL (auto-Railway)
FIREBASE_PROJECT_ID
FIREBASE_PRIVATE_KEY
FIREBASE_CLIENT_EMAIL
CLOUDINARY_URL                    # OU 3 vars séparées
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
JWT_SECRET
PORT
NODE_ENV                          # production
RESEND_API_KEY                    # ajoutée 29/04/2026, en pending (deploy Session 26)
EMAIL_FROM                        # à ajouter Session 26 : login@over7.app
```

## 👥 Users de test en DB

- **Luca/Amin** (Google maher250670@gmail.com) : `user_id=b70c2149-2238-436f-98db-7366534f812b`
- **Sarah originale** : `4612f95a-bd0d-4822-bf23-97fb6645234c`
- 6 users arena-validated backfillés : Marine, Thomas, Sophie, Luca-test (c2db73ef), Lucas, Julie

### Forcer Luca dans pool pour tests

```sql
UPDATE users SET is_in_pool=TRUE, arena_votes_given=20,
  arena_votes_received=20, avg_rating=7.5, pool_unlocked_at=NOW()
WHERE user_id='b70c2149-2238-436f-98db-7366534f812b';
```

## 🎯 Roadmap prochaines sessions

### Session 26 — Frontend Expo SDK + OTP (5-6h)
- Frontend Expo SDK 54 → 55 (audit déjà fait)
- Backend OTP via Resend (table otp_codes, routes auth, service email)
- Frontend OTP UI (connecter formulaire existant)

### Session 27 — Cleanup + Documentation (2-3h)
- Nettoyer 3 warnings ESLint
- Ajouter `npm run lint` à la CI
- Créer README.md à la racine avec badges
- Ajouter coverageThreshold dans Jest config

### Session 28 — Backlog edge cases métier (3-4h)
~30 edge cases flagués (cf SESSION_26_REPRISE.md ou backlog/ folder)

### Sessions 29+ — Production readiness
- Migration Expo Go → Dev client + EAS Build
- Certificats iOS/Android
- TestFlight + Play Store internal track

## 📜 Workflow de session standardisé

1. **Début** : Amin dit "On reprend Over7 Session X" + colle CLAUDE.md ou doc reprise
2. **Audit obligatoire** avant tout bump majeur ou refactor risqué
3. **Plan validé par Amin** avant implémentation
4. **Implémentation** étape par étape
5. **Tests local** (`npm test`) + lint (`npm run lint`)
6. **From-scratch** (`rm -rf node_modules && npm install && npm test`)
7. **Commit + push** avec message détaillé
8. **CI verte attendue** sur GitHub Actions
9. **Railway deploy auto** surveillé
10. **Test E2E manuel** sur téléphone Amin (login + flow critique)
11. **Pauses obligatoires** entre items risqués

## ⚠️ Règles strictes

- **JAMAIS** modifier directement sans audit préalable sur du sensible
- **JAMAIS** push si tests locaux KO (même 1 seul test)
- **JAMAIS** ignorer un warning ESLint qui est en mode "error"
- **JAMAIS** ajouter une dep sans expliquer à Amin pourquoi
- **JAMAIS** continuer si Amin montre des signes de fatigue cognitive
- **TOUJOURS** noter un rollback point (commit hash) avant changement risqué
- **TOUJOURS** valider le plan avec Amin avant exécution complexe
- **TOUJOURS** finir par un rapport structuré (statuts, métriques, lien CI)

## 📚 Références complémentaires

- `SESSION_26_REPRISE.md` (si présent à la racine) : doc complet Sessions 24/25/25bis avec ~30 edge cases backlog
- Frontend CLAUDE.md : `C:\Projets\Over7\Over7\CLAUDE.md` (contexte React Native/Expo)

## 📊 Bilan Sessions 24+25+25bis (29 avril 2026)

| Métrique | Valeur |
|---|---|
| Commits | 25 |
| CI verts | 25/25 (100%) |
| Tests Jest | 107 → 259 (+152) |
| Coverage lines | 83.52% |
| Vulnérabilités | 9 → 2 (résiduelles) |
| Bumps majeurs livrés | 8 (firebase 13, helmet 8, dotenv 17, lru-cache 11, Express 5, Multer 2, uuid→crypto, bcryptjs cleanup) |
| Outils ajoutés | Codecov + ESLint + Prettier |
