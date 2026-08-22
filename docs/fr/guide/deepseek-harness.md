# DeepSeek Harness

L'agent de codage open source officiel de DeepSeek. Il tourne sur votre machine.

Il a une interface web, à l'adresse `localhost:3080`.

Une interface web, cela veut dire que Voyager peut y entrer.

## Pourquoi ça marche

Le Gestionnaire de Prompts de Voyager ne regarde pas les domaines. Il regarde les sites que vous avez ajoutés.

Une adresse locale est un site.

DeepSeek Harness ne diffère donc en rien de Gemini, Claude ou ChatGPT — un endroit de plus où vos prompts vous suivent.

## Trois étapes

### 1. Lancer DSH

```bash
npm i -g @deepseek-ai/dsh
dsh web
```

Ouvrez `http://localhost:3080` dans votre navigateur.

### 2. Activer l'interrupteur dans la popup

![Cliquez sur l'icône puzzle de la barre d'outils, cliquez sur Voyager, puis activez le Gestionnaire de Prompts sur localhost:3080](/assets/dsh-enable-steps-en.png)

Comme vous êtes déjà sur `localhost:3080`, la popup vous le propose tout en haut. Activez-le et accordez l'accès.

Rien à taper.

### 3. Recharger la page

Le bouton flottant apparaît en bas à droite.

![Gestionnaire de Prompts dans DeepSeek Harness](/assets/prompt-manager-deepseek-harness.png)

## Une seule bibliothèque, partout

Vous n'avez pas une bibliothèque par site. Vous en avez une seule, et elle vous suit.

Chaque prompt enregistré sur Gemini, Claude ou ChatGPT est déjà là quand vous ouvrez DSH. Tous, sans exception. Et l'inverse est vrai aussi : écrivez un prompt dans DSH, il vous attend de retour sur Gemini.

Mêmes étiquettes, mêmes favoris, même recherche.

![Une seule bibliothèque qui atteint chaque interface](/assets/one-prompt-library.png)

## Quelques remarques

**Le port n'est pas figé.** DSH en est encore à une préversion pour développeurs, et son port par défaut peut changer. Si c'est le cas, ajoutez simplement le nouveau.

**Seul le Gestionnaire de Prompts se charge.** La Chronologie, les Dossiers et le reste sont faits pour Gemini et ne démarrent pas sur un site personnalisé.

**Vos prompts ne quittent jamais la machine.** DSH est local, la bibliothèque de Voyager est locale. Rien ne sort de la chaîne.

::: tip
La même méthode fonctionne pour n'importe quelle interface web locale — Open WebUI, LibreChat, celle que vous avez écrite vous-même. Ajoutez l'adresse, rechargez, c'est fait.
:::
