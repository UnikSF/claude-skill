# claude-skill

Marketplace de plugins Claude Code d'UnikSF.

## Installation

Dans Claude Code :

```
/plugin marketplace add UnikSF/claude-skill
/plugin install dev-team@uniksf-skills
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

## Structure

```
.claude-plugin/marketplace.json
plugins/
  dev-team/
    .claude-plugin/plugin.json
    skills/dev/SKILL.md
    agents/po-fonctionnel.md
    agents/developpeur.md
```
