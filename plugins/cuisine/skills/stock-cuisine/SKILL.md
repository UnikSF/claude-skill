---
name: "stock-cuisine"
description: "Gérer le stock d'ingrédients de Maxime : à utiliser pour tout menu, plan batch cooking ou liste de courses, et dès qu'il annonce un achat, un plat cuisiné ou son stock."
---

# Stock cuisine

Les données vivent dans le dépôt de mémoire GitHub privé `UnikSF/claude-memory` (pas dans ce plugin) : stock dans `cuisine/stock.md`.
Les préférences de repas sont dans `cuisine/batch-cooking.md`.
Si le dépôt n'est pas dans la session, l'ajouter (add_repo) et le cloner avant de continuer.

## Avant un menu ou une liste de courses

1. Lire `cuisine/stock.md` et `cuisine/batch-cooking.md`.
2. Construire les recettes en utilisant d'abord ce qui est en stock, en priorité ce qui se périme (viande, frais).
3. Liste de courses : une par semaine, uniquement ce qui manque pour les recettes de cette semaine, en déduisant le stock. Prix du drive E.Leclerc Pau Université ; marquer « ? » un prix non vérifié.
4. Indiquer ce qui restera en stock après la semaine.

## Mise à jour du stock

Déclencheurs : Maxime donne son stock, dit avoir acheté quelque chose, avoir cuisiné un plat, ou qu'il ne lui reste plus un ingrédient.

1. `git pull` dans le clone de `UnikSF/claude-memory`, puis lire `cuisine/stock.md`.
2. Réécrire la section « ## Stock au JJ/MM/AAAA » avec la date du jour :
   - stock annoncé par Maxime → il remplace tout l'ancien stock ;
   - achat → ajouter les quantités ;
   - plat cuisiné → retirer les quantités de la recette ;
   - « plus de X » → retirer X.
3. Une ligne par ingrédient, au format `- [stated] quantité + ingrédient`. Ne garder que l'état courant, pas d'historique (l'historique est dans git).
4. Commit (`stock: <résumé>`) et push sur `main` de `UnikSF/claude-memory`.
5. Si une quantité est déduite d'une recette plutôt que dite par Maxime, le signaler en une ligne dans la réponse pour qu'il corrige.

## Réponse

Courte. Ne pas annoncer la sauvegarde ; dire seulement ce qui change pour les recettes ou les courses.
