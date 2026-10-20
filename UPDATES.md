# Publier une mise à jour de Raye Square

L’application recherche une mise à jour au démarrage en version distribuée. Le bouton « Mises à jour » permet aussi une recherche manuelle. L’utilisateur choisit quand installer. Une connexion indisponible ne bloque pas le démarrage.

## Première installation

L’ancienne version n’a pas ce système : installer une première fois le nouvel installateur depuis GitHub Releases. Les versions suivantes pourront proposer leurs mises à jour dans l’application.

## Publication

1. Modifier la version dans `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` et `src-tauri/tauri.conf.json` en conservant des versions cohérentes.
2. Vérifier `npm run build` et `cargo test --locked --manifest-path src-tauri/Cargo.toml`.
3. Envoyer les changements, puis créer et pousser le tag correspondant, par exemple `v0.1.1`.
4. Le workflow Windows compile, teste et crée une release **en brouillon**, avec installateurs, signatures et `latest.json`.
5. Tester l’installateur et publier le brouillon depuis GitHub Releases. Seules les releases publiées sont proposées aux utilisateurs.

Le workflow peut aussi être lancé manuellement depuis GitHub Actions pour la version courante.

## Signature

La clé privée locale est dans `secrets/updater.key`, exclue de Git. Elle est également enregistrée de façon chiffrée dans le secret GitHub `TAURI_SIGNING_PRIVATE_KEY`. La clé publique de vérification est dans `tauri.conf.json`. La clé a été générée sans mot de passe ; le secret de mot de passe GitHub peut rester absent.

Conserver une sauvegarde privée de la clé : sa perte empêche de signer les futures mises à jour reconnues par les installations existantes. Ne jamais la joindre à une release ni la committer.

Cette signature vérifie les mises à jour Tauri ; elle ne constitue pas une signature Authenticode Windows. Windows peut afficher un avertissement d’éditeur inconnu.

Le nom technique et l’identifiant de l’application sont conservés pour garder la continuité avec l’installation actuelle et ses données.

## Vérification finale

Après publication, tester un passage réel entre deux versions sur un PC Windows. Les tests unitaires et la compilation ne vérifient pas à eux seuls le téléchargement, l’installation et la conservation des préférences sur une machine installée.
