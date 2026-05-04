# Aquabike Evolution Dakar — Booking & Subscriptions

Application de réservation en temps réel avec paiement Wave / Orange Money.

## Fonctionnalités

- Calendrier interactif de réservation (8 places/créneau)
- 6 formules d'abonnement avec limites automatiques
- Paiement Wave API + Orange Money + espèces
- Synchronisation temps réel (SSE)
- Auth par téléphone + PIN
- Interface mobile-first
- Politique d'annulation 2h

## Abonnements

| Formule | Prix | Séances | Validité |
|---------|------|---------|----------|
| Mensuel 3x/sem | 65.000F | 3/semaine | 30 jours |
| Mensuel 5x/sem | 80.000F | 5/semaine | 30 jours |
| Carte 10 séances | 75.000F | 10 total | 90 jours |
| Rééducation 10 | 200.000F | 10 total | 180 jours |
| Natation 10 | 80.000F | 10 total | 180 jours |
| Séance test | 10.000F | 1 | 30 jours |

## Horaires

- **Aquabike/Aquagym** : Lun-Ven 8h-13h + 17h-20h | Sam-Dim 10h-13h
- **Rééducation/Natation** : Tous les jours 13h-17h

## Déploiement Render

1. Push ce repo sur GitHub
2. Crée une base PostgreSQL (Free) sur Render
3. Crée un Web Service Docker pointant vers ce repo
4. Ajoute DATABASE_URL, ADMIN_CODE, JWT_SECRET
5. Pour Wave: ajoute WAVE_API_KEY (obtenu sur wave.com/developers)

## Premier lancement

1. Inscris-toi depuis l'app
2. Deviens admin: POST /api/admin/set-role avec {phone, admin_code}
3. Onglet Admin → Génère les créneaux
4. Les clients peuvent réserver !

## Variables d'environnement

| Variable | Description |
|----------|-------------|
| DATABASE_URL | Connection PostgreSQL |
| ADMIN_CODE | Code pour devenir admin |
| JWT_SECRET | Secret JWT (auto-généré si absent) |
| WAVE_API_KEY | Clé API Wave (optionnel) |
| OM_MERCHANT_KEY | Clé Orange Money (optionnel) |
| APP_URL | URL publique de l'app |

MIT — Guess Too © 2026
