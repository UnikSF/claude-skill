# pc-insomnia

Un mod Claude Code qui **garde votre PC éveillé pendant que Claude travaille**,
et, en option, **même capot fermé**. Inspiré de
[Insomnia](https://github.com/krishhgg/Insomnia) (macOS), adapté à Windows.

- Claude commence une réponse : la mise en veille est bloquée.
- Claude a fini : la veille revient après un délai (5 min par défaut).
- `/insomnia 2h` : éveillé jusqu'à une heure donnée, même sans Claude.
- `/insomnia lid on` : fermer le capot ne met plus le PC en veille pendant le
  maintien éveillé. Le réglage d'origine est remis à la fin.
- La ligne d'état affiche `👁 éveillé · capot ok · Claude travaille`.

> ⚠ **Capot fermé = le PC continue de chauffer.** Posez-le sur une surface
> dure et ventilée, jamais dans un sac fermé.

## Installation

Dans Claude Code, une fois la branche fusionnée dans la branche par défaut :

```
/plugin marketplace add UnikSF/claude-skill
/plugin install pc-insomnia@uniksf-skills
```

Avant la fusion, depuis la branche :

```bash
git clone --branch claude/insomnia-windows-compat-hlioha https://github.com/UnikSF/claude-skill.git
claude plugin marketplace add ./claude-skill
claude plugin install pc-insomnia@uniksf-skills
```

Pour l'essayer sans l'installer : `claude --plugin-dir ./claude-skill/plugins/pc-insomnia`.

## Commandes

| Commande | Effet |
| --- | --- |
| `/insomnia` | état actuel |
| `/insomnia 2h`, `45m`, `1h30` | éveillé jusqu'à cette heure-là, même sans Claude (12 h max) |
| `/insomnia off` | annule le minuteur et le délai |
| `/insomnia lid on` / `off` | ne pas dormir capot fermé |
| `/insomnia screen on` / `off` | garder aussi l'écran allumé |
| `/insomnia grace 10` | délai après la fin d'une réponse, en minutes (0 = aucun) |

Les réglages sont gardés d'une session à l'autre.

## Comment ça marche

| Système | Maintien éveillé | Capot fermé |
| --- | --- | --- |
| **Windows** | `powershell.exe` appelle `SetThreadExecutionState` | le plan d'alimentation passe à « Ne rien faire » quand on ferme le capot (`LIDACTION`), sur secteur et sur batterie |
| **WSL** | pareil, via `powershell.exe` côté Windows | pareil |
| macOS | `caffeinate -i` | non géré : il faut `sudo pmset`, utilisez l'app Insomnia |
| Linux | `systemd-inhibit` | `systemd-inhibit --what=handle-lid-switch` |

Le maintien éveillé est un processus enfant de Claude Code. S'il s'arrête
(fin de session, plantage, kill), le système reprend la main tout seul.

Le réglage du capot sous Windows, lui, **reste en place si rien ne le remet**.
Trois sécurités :

1. **Journal d'abord.** Les valeurs d'origine sont écrites dans
   `%LOCALAPPDATA%\PcInsomnia\lid.json` *avant* toute modification.
2. **Restauration à la fin**, par le mod. Si Claude Code meurt, le processus
   PowerShell s'en aperçoit (en 10 s au plus) et restaure tout seul.
3. **Nettoyage au démarrage.** Chaque nouvelle session restaure un réglage
   laissé par un arrêt brutal (redémarrage, kill).

Plusieurs sessions Claude peuvent tenir le capot en même temps : la dernière
qui s'arrête remet le réglage d'origine.

Restauration à la main, si besoin (valeur `1` = veille, le défaut Windows) :

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1
powercfg /setactive SCHEME_CURRENT
Remove-Item "$env:LOCALAPPDATA\PcInsomnia\lid.json"
```

## Limites connues

- **Pas encore testé sur un vrai Windows.** Le code est validé et typé, et
  ses tests automatiques passent. La partie PowerShell n'a été vérifiée qu'à
  la lecture.
- Sur un PC géré par une entreprise, une stratégie de groupe peut verrouiller
  le réglage du capot. Le mod l'annonce et garde seulement le PC éveillé
  capot ouvert.
- Certains portables « Modern Standby » peuvent quand même ralentir des
  applications capot fermé.
- Sous WSL, si Claude Code est tué brutalement, le maintien côté Windows dure
  au plus 12 h.
- Rien ne surveille la température : c'est à vous de ne pas l'enfermer.

## Développement

```bash
claude plugin validate plugins/pc-insomnia
claude plugin test plugins/pc-insomnia
```
