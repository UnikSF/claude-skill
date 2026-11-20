# claude-skill

Marketplace de plugins Claude Code d'UnikSF.

## Installation

Dans Claude Code :

```
/plugin marketplace add UnikSF/claude-skill
/plugin install dev-team@uniksf-skills
/plugin install pc-insomnia@uniksf-skills
/plugin install cuisine@uniksf-skills
```

## Plugins

### `dev-team`

Le skill `/dev` orchestre une petite équipe :

| Rôle | Modèle | Responsabilité |
|---|---|---|
| Advisor | Fable | Pilote, fait le plan technique, relit le code, commite |
| PO fonctionnel (`dev-team:po-fonctionnel`) | Opus | Cadrage (user stories, critères d'acceptation) puis recette. Ne code pas |
| Développeur (`dev-team:developpeur`) | Sonnet | Implémente, teste, résume ses changements |

Utilisation : `/dev <fonctionnalité ou correction>` (ou `/dev-team:dev` si un autre skill porte le même nom).

Déroulé : cadrage → plan technique → implémentation → revue + recette (2 itérations de correction max) → commit et compte rendu.

### `pc-insomnia`

Un mod qui garde le PC éveillé pendant que Claude travaille, et en option même capot fermé (Windows, WSL ; macOS et Linux sans le capot sous macOS). Commande `/insomnia` : `2h`, `off`, `lid on|off`, `screen on|off`, `grace <min>`. Détails dans [plugins/pc-insomnia/README.md](plugins/pc-insomnia/README.md).

### `cuisine`

Skill `stock-cuisine` : menus, plans batch cooking et listes de courses (drive E.Leclerc Pau Université) en partant du stock, et mise à jour du stock quand Maxime achète, cuisine ou annonce son stock. Les données (`cuisine/stock.md`, `cuisine/batch-cooking.md`) vivent dans le dépôt de mémoire privé [UnikSF/claude-memory](https://github.com/UnikSF/claude-memory), pas ici.

## Structure

```
.claude-plugin/marketplace.json
plugins/
  dev-team/
    .claude-plugin/plugin.json
    skills/dev/SKILL.md
    agents/po-fonctionnel.md
    agents/developpeur.md
  pc-insomnia/
    .claude-plugin/plugin.json
    hooks/hooks.json
    hooks/register.ts
    hooks/windows.ts
    hooks/register.test.ts
  cuisine/
    .claude-plugin/plugin.json
    skills/stock-cuisine/SKILL.md
```
