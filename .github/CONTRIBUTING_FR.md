# Guide de Contribution

> [!CAUTION]
> **Ce projet n'accepte actuellement PAS les PRs pour de nouvelles fonctionnalités.** Si vous souhaitez vraiment développer une fonctionnalité, veuillez suivre ce processus :
>
> 1. **Ouvrez d'abord un Issue** pour discuter de votre idée et de votre approche avec le mainteneur
> 2. **Attendez l'approbation et un plan d'implémentation solide** avant d'écrire du code ou de soumettre une PR
>
> Les PRs de nouvelles fonctionnalités soumises sans discussion préalable seront fermées sans examen. Merci de votre compréhension.

> [!IMPORTANT]
> **Statut du projet : Maintenance réduite.** Attendez-vous à des délais de réponse. Les PR avec tests sont prioritaires.

Merci d'envisager de contribuer à Voyager ! 🚀

Ce document fournit des directives et des instructions pour contribuer. Nous accueillons les corrections de bugs, les améliorations de la documentation et les traductions. Pour les nouvelles fonctionnalités, veuillez d'abord en discuter via un Issue.

## 🚫 Politique IA

**Nous rejetons explicitement les PR générées par l'IA qui n'ont pas été vérifiées manuellement.**

Bien que les outils d'IA soient d'excellents assistants, les contributions "paresseuses" de copier-coller font perdre du temps aux mainteneurs.

- **Les PR d'IA de mauvaise qualité** seront fermées immédiatement sans discussion.
- **Les PR sans explication** de la logique ou manquant de tests nécessaires seront rejetées.
- Vous devez comprendre et assumer la responsabilité de chaque ligne de code que vous soumettez.

## Processus Obligatoire

1. Pour une nouvelle fonctionnalité, ouvrez un Issue et attendez l'accord explicite sur l'approche ; `/claim` ou une assignation désigne seulement la personne responsable.
2. Soumettez chaque changement dans une PR ciblée depuis une branche thématique ; ne poussez pas directement sur `main`.
3. Exécutez `bun run format`, `bun run lint` et `bun run verify:pr`, dans cet ordre, et indiquez toute omission. Pour les changements de documentation uniquement (docs/README), `bun run format:check` plus `bun run docs:build` peuvent remplacer le `verify:pr` complet.
4. Ajoutez des tests de régression pour les changements de comportement ou expliquez pourquoi l'automatisation n'est pas utile.
5. Chargez l'artefact réel dans les navigateurs concernés et testez le parcours modifié ; indiquez dans la PR la couverture restante et son responsable.

> 💡 Si vous contribuez avec un agent IA (Claude Code, Codex, …), demandez-lui d'utiliser la skill `voyager-contribute` fournie dans le dépôt (dans `.claude/skills/` et `.agents/skills/`) : elle encode ce flux ainsi que les pièges spécifiques au dépôt qui ont coûté le plus de cycles de revue. Les agents hors du checkout du dépôt (p. ex. Cursor) peuvent l'installer via `npx skills add Nagi-ovo/voyager -s voyager-contribute`.

## Table des Matières

- [Commencer](#commencer)
- [Réclamer un Ticket](#réclamer-un-ticket)
- [Configuration de Développement](#configuration-de-développement)
- [Apporter des Modifications](#apporter-des-modifications)
- [Soumettre une Pull Request](#soumettre-une-pull-request)
- [Style de Code](#style-de-code)
- [Ajouter le Support d'un Gem](#ajouter-le-support-dun-gem)
- [Licence](#licence)

---

## Commencer

### Prérequis

- **Bun 1.3.12** (aligné sur `packageManager` et la CI)
- **GitHub CLI (`gh`)** ([installation](https://cli.github.com/)) : installez-le et authentifiez-vous avec `gh auth login`, puis exécutez `gh auth status` pour vérifier que le compte actif est bien celui avec lequel vous souhaitez contribuer; la skill `voyager-contribute` s'en sert pour consulter et publier les Issues/PRs. Sans `gh`, utilisez l'interface web GitHub et signalez-le dans la PR.
- Les navigateurs concernés pour charger l'extension et tester le parcours réel

### Démarrage Rapide

```bash
# Cloner le dépôt
git clone https://github.com/Nagi-ovo/voyager.git
cd voyager

# Installer les dépendances
bun install

# Démarrer le mode développement
bun run dev
```

---

## Réclamer un Ticket

Pour éviter le travail en double et coordonner les contributions :

### 1. Vérifier le Travail Existant

Avant de commencer, vérifiez si le ticket est déjà assigné à quelqu'un en regardant la section **Assignees**.

### 2. Réclamer un Ticket

Pour un ticket non assigné **sans** le label `community-only`, commentez `/claim` pour vous l'assigner automatiquement. Un bot confirmera l'assignation.

### 3. Tickets réservés à la communauté

Les tickets portant le label `community-only` sont réservés aux membres vérifiés de la communauté Voyager :

1. Le membre de la communauté commente `/claim`.
2. Un mainteneur vérifie son appartenance et commente `/approve @utilisateur`.
3. Ne commencez l'implémentation ou n'ouvrez une PR qu'après l'assignation par le bot.

Le label retire automatiquement `help wanted` et `good first issue`. Les autres contributeurs peuvent rejoindre le [Discord Voyager](https://discord.gg/TEUFxdMbGb) ou choisir un ticket sans `community-only`.

### 4. Libérer si Nécessaire

Si vous ne pouvez plus travailler sur un ticket, commentez `/unclaim` pour le libérer pour d'autres.

### 5. Case à Cocher de Contribution

Lors de la création de tickets, vous pouvez cocher la case "I am willing to contribute code" pour indiquer votre intérêt à implémenter la fonctionnalité ou le correctif.

---

## Configuration de Développement

### Installer les Dépendances

```bash
bun install
```

### Commandes Disponibles

| Commande              | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `bun run dev`         | Démarrer le mode dev Chrome avec rechargement à chaud |
| `bun run dev:firefox` | Démarrer le mode dev Firefox                          |
| `bun run dev:safari`  | Démarrer le mode dev Safari (macOS uniquement)        |
| `bun run build`       | Build de production pour Chrome                       |
| `bun run build:edge`  | Build et paquet Edge indépendants                     |
| `bun run build:all`   | Builds Chrome + Firefox + Safari                      |
| `bun run lint`        | Exécuter ESLint avec correction automatique           |
| `bun run typecheck`   | Exécuter la vérification de type TypeScript           |
| `bun run test`        | Exécuter la suite de tests                            |
| `bun run verify:pr`   | Vérification automatisée locale standard d'une PR     |

### Charger l'Extension

1. Exécutez `bun run dev` pour démarrer le build de développement
2. Ouvrez Chrome et allez sur `chrome://extensions/`
3. Activez le "Mode développeur"
4. Cliquez sur "Charger l'extension non empaquetée" et sélectionnez le dossier `dist_chrome_dev`

---

## Apporter des Modifications

### Avant de Commencer

1. **Créez une branche** depuis `main` :

   ```bash
   git checkout -b feature/nom-de-votre-fonctionnalite
   # ou
   git checkout -b fix/votre-correction-de-bug
   ```

2. **Lier les Issues** - Lors de l'implémentation d'une nouvelle fonctionnalité, vous devez **d'abord ouvrir un Issue pour discussion**. Les PR pour de nouvelles fonctionnalités soumises sans discussion préalable seront fermées. Lors de la soumission d'une PR, veuillez lier cet Issue.

3. **Gardez les modifications ciblées** - une fonctionnalité ou correction par PR

### Liste de Contrôle Pré-Commit

Avant de soumettre, exécutez toujours :

```bash
bun run format     # Formater le code
bun run lint       # Corriger les problèmes de linting
bun run verify:pr  # Exécuter la vérification locale standard
```

Assurez-vous que :

1. Vos modifications réalisent la fonctionnalité souhaitée.
2. Vos modifications n'affectent pas négativement les fonctionnalités existantes.

---

## Stratégie de Test

Testez l'interface la plus susceptible de régresser : automatisez la logique et les états complexes, ajoutez un test DOM minimal lorsque les sélecteurs ou la navigation SPA changent, puis vérifiez le parcours réel avec l'extension chargée.

---

## Soumettre une Pull Request

### Directives de PR

1. **Titre** : Utilisez un titre clair et descriptif (ex: "feat: add dark mode toggle" ou "fix: timeline scroll sync")
2. **Description** : Expliquez quels changements vous avez effectués et pourquoi
3. **Impact Utilisateur** : Décrivez comment les utilisateurs seront affectés
4. **Preuve Visuelle (Strict)** : Pour TOUT changement d'interface ou nouvelle fonctionnalité, vous **DEVEZ** fournir des captures d'écran ou des enregistrements. **Pas de capture = Pas de revue/réponse.**
5. **Référence de Ticket** : Liez les tickets associés (ex: "Closes #123")

### Format du Message de Commit

Suivez [Conventional Commits](https://www.conventionalcommits.org/) :

- `feat:` - Nouvelles fonctionnalités
- `fix:` - Corrections de bugs
- `docs:` - Changements de documentation
- `chore:` - Tâches de maintenance
- `refactor:` - Refactorisation de code
- `test:` - Ajout ou mise à jour de tests

---

## Style de Code

### Directives Générales

- **Préférez les retours anticipés** aux conditionnelles imbriquées
- **Utilisez des noms descriptifs** - évitez les abréviations
- **Évitez les nombres magiques** - utilisez des constantes nommées
- **Respectez le style existant** - la cohérence prime sur la préférence

### Conventions TypeScript

- **PascalCase** : Classes, interfaces, types, énumérations, composants React
- **camelCase** : Fonctions, variables, méthodes
- **UPPER_SNAKE_CASE** : Constantes

### Ordre d'Importation

1. React et imports liés
2. Bibliothèques tierces
3. Imports absolus internes (`@/...`)
4. Imports relatifs (`./...`)
5. Imports de type uniquement

```typescript
import React, { useState } from 'react';

import { marked } from 'marked';

import { Button } from '@/components/ui/Button';
import { StorageService } from '@/core/services/StorageService';
import type { FolderData } from '@/core/types/folder';

import { parseData } from './parser';
```

---

## Ajouter le Support d'un Gem

Pour ajouter le support d'un nouveau Gem (Gems officiels Google ou Gems personnalisés) :

1. Ouvrez `src/pages/content/folder/gemConfig.ts`
2. Ajoutez une nouvelle entrée au tableau `GEM_CONFIG` :

```typescript
{
  id: 'votre-id-gem',          // Depuis l'URL : /gem/votre-id-gem/...
  name: 'Nom de Votre Gem',    // Nom d'affichage
  icon: 'material_icon_name',  // Nom de l'icône Google Material Symbols
}
```

### Trouver l'ID du Gem

- Ouvrez une conversation avec le Gem
- Vérifiez l'URL : `https://gemini.google.com/app/gem/[GEM_ID]/...`
- Utilisez la partie `[GEM_ID]` dans votre configuration

### Choisir une Icône

Utilisez des noms d'icônes valides de [Google Material Symbols](https://fonts.google.com/icons) :

| Icône          | Cas d'Utilisation        |
| -------------- | ------------------------ |
| `auto_stories` | Apprentissage, Éducation |
| `lightbulb`    | Idées, Brainstorming     |
| `work`         | Carrière, Professionnel  |
| `code`         | Programmation, Technique |
| `analytics`    | Données, Analyse         |

---

## Portée du Projet

Voyager améliore l'expérience de chat Gemini AI avec :

- Navigation par chronologie
- Organisation par dossiers
- Coffre-fort de prompts
- Exportation de chat
- Personnalisation de l'interface utilisateur

> [!NOTE]
> **Nous considérons que l'ensemble des fonctionnalités de Voyager est déjà complet et suffisant.** Ajouter trop de fonctionnalités de niche ou trop personnalisées n'améliore pas le logiciel — cela ne fait qu'alourdir la charge de maintenance. À moins que vous ne considériez qu'une fonctionnalité est véritablement essentielle et bénéficierait à la majorité des utilisateurs, veuillez reconsidérer votre Feature Request.

**Hors de portée** : Scraping de site, interception réseau, automatisation de compte.

---

## Obtenir de l'Aide

- 💬 [GitHub Discussions](https://github.com/Nagi-ovo/voyager/discussions) - Poser des questions
- 🐛 [Issues](https://github.com/Nagi-ovo/voyager/issues) - Signaler des bugs
- 📖 [Documentation](https://voyager.nagi.fun/) - Lire la documentation

---

## Licence

En contribuant, vous acceptez que vos contributions soient licenciées sous la [Licence GPLv3](../LICENSE).
