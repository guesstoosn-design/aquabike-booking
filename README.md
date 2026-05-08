# Fichiers à remplacer dans la repository GitHub

Structure attendue :

```
/
├── server.js
├── package.json
└── public/
    └── index.html
```

## Important

- Remplacer le `server.js` à la racine par celui fourni.
- Remplacer le `package.json` à la racine par celui fourni.
- Créer un dossier `public` si absent.
- Mettre le fichier `index.html` fourni dans `public/index.html`.
- Si un ancien `index.html` existe à la racine, le supprimer ou le laisser inutilisé, mais le bon fichier doit être dans `public/index.html`.

## Après upload GitHub

1. Cliquer sur `Commit changes`.
2. Aller sur Render.
3. Cliquer `Manual Deploy` puis `Deploy latest commit`.
4. Tester :
   - `/health` doit afficher `{ "ok": true, "db": true }`.
   - `/api/plans` doit afficher les formules.
   - Générer les créneaux depuis l'espace admin.
