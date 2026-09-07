# Guide de contribution aux plugins

Le système de plugins de Voyager privilégie les plugins déclaratifs : `plugin.json` décrit les métadonnées et les opérations DOM, tandis que CSS décrit les styles. Le plugin n'exécute pas de JavaScript distant ; le moteur intégré de Voyager interprète le manifest et les styles.

Cette approche rend les plugins plus faciles à relire et à maintenir. Si vous voulez contribuer un plugin, commencez par là.

## Parcours recommandé

1. Vérifiez d'abord que l'idée convient à un plugin : largeur de lecture, corrections de mise en page, ajustements de thème, masquage ou marquage d'éléments, adaptations simples de sites.
2. Ouvrez d'abord une Issue dans le dépôt Voyager. Expliquez le problème, le site cible et la différence avec les plugins existants ; attendez l'accord explicite d'un mainteneur avant de coder ou d'ouvrir une PR.
3. Utilisez `plugin.json` pour les métadonnées, les sites ciblés, les réglages et les contributions.
4. Placez les styles dans `style.css` dans le même dossier, puis référencez-le depuis `contributes.styles`.
5. Testez localement et ajoutez à la PR des pages de test, captures d'écran ou une courte vidéo. Les mainteneurs décideront ensuite si le plugin est prêt pour le catalog officiel.

## Arborescence

Les plugins officiels fournis avec l'extension vivent sous `src/features/plugins/catalog/`, un dossier par plateforme :

```
src/features/plugins/catalog/
  marketplace.json                        index lu par le magasin de la documentation
  sites/<site>/site.json                  l'adaptateur de site, sous forme de données
  sites/<site>/plugins/<id>/plugin.json   un plugin déclaratif
  sites/<site>/plugins/<id>/style.css     ses styles
  sites/<site>/plugins/<id>/README.md     ce qu'il corrige et pourquoi
```

La découverte est automatique : `catalog/sites/index.ts` trouve chaque `site.json` et chaque `plugin.json` avec `import.meta.glob`. Ajouter un site ou un plugin revient donc à ajouter des fichiers, sans table de correspondance à modifier.

`marketplace.json` n'est pas cette table : c'est seulement l'index que lit le magasin de plugins de la documentation. Un test le garde synchronisé avec la découverte, donc un nouveau plugin doit aussi y figurer. Son `source` est le chemin relatif au catalog, par exemple `sites/deepseek/plugins/reading-width/plugin.json`.

`site.json` est l'adaptateur de site lui-même, écrit comme des données. Les plateformes actuelles sont ChatGPT, Claude et DeepSeek. Gemini et AI Studio sont des surfaces natives de Voyager et restent des adaptateurs TypeScript, tandis que `sites/adapters/claude.ts`, `chatgpt.ts` et `deepseek.ts` ne sont plus que des coquilles d'une ligne au-dessus de leur `site.json` : modifiez le JSON, pas le TypeScript. Le catalogue publié par hôte transporte aussi les données du site, donc une correction de sélecteur atteint les utilisateurs sans nouvelle version de l'extension.

Les `matches` d'un plugin doivent rester à l'intérieur des `matches` de son site. Un plugin qui déborde fait échouer le build.

## Clés de sélecteurs sémantiques

`site.json` associe un vocabulaire fixe de clés sémantiques aux sélecteurs CSS propres au site. Ce vocabulaire est défini dans `src/features/plugins/sites/semanticKeys.ts` ; un `site.json` ne peut utiliser que ces clés, et toute clé inconnue est rejetée.

- `userTurn` : le conteneur d'un message utilisateur.
- `assistantTurn` : le conteneur d'un message de l'assistant.
- `thinkingBlock` : la section de raisonnement dans une réponse.
- `codeBlock` : un bloc de code rendu.
- `composer` : le champ de saisie du prompt.
- `sidebar` : la liste des conversations ou le rail de navigation.
- `sidePanel` : un panneau secondaire, par exemple artifacts ou canvas.
- `headerActions` : le groupe d'actions en haut à droite de la conversation.
- `scrollContainer` : l'élément qui fait défiler la conversation.

Un site ne déclare que les clés qu'il peut réellement fournir. Les plugins référencent une clé plutôt qu'un sélecteur brut en écrivant `{ "kind": "semantic", "key": "userTurn" }` comme `target` d'une opération DOM ; une refonte du site se corrige alors dans le seul `site.json`.

`conversationIdPattern` est un champ distinct de `site.json`, pas un sélecteur : une expression régulière sur le chemin de l'URL dont le premier groupe capturant est l'identifiant de conversation, par exemple `^/chat/([^/?#]+)`.

## Périmètre d'un plugin

Le périmètre d'un plugin doit suivre le problème utilisateur, pas une séparation mécanique par plateforme.

Si la même fonctionnalité offre une expérience et des réglages presque identiques sur plusieurs plateformes, préférez un plugin multiplateforme. Par exemple, largeur de lecture, navigation entre pages ou mise en page des blocs de code peuvent souvent couvrir Claude, ChatGPT et d'autres sites via plusieurs `matches`.

Si chaque plateforme exige des réglages, une logique DOM ou des textes très différents, des plugins séparés seront plus clairs. Ne forcez pas des fonctions sans lien dans un seul plugin pour qu'il "fasse tout" ; un plugin doit résoudre un problème clair.

Règle rapide :

- Même objectif utilisateur, mêmes réglages, seuls les sélecteurs changent : préférez un plugin unique.
- Même thème mais expérience très différente selon la plateforme : vous pouvez séparer, en gardant des noms et descriptions liés.
- Objectifs différents : ne fusionnez pas.

## Éviter les doublons

Avant de proposer un plugin, vérifiez le marketplace et les plugins officiels existants. Si un bon plugin existe déjà, améliorez-le plutôt que d'en créer un similaire.

Un doublon ne vaut la peine que s'il apporte une amélioration claire, par exemple :

- Il couvre une plateforme importante non prise en charge par l'original.
- Il corrige un problème de compatibilité que l'original ne parvient pas à résoudre.
- Il améliore clairement les performances, l'accessibilité ou la maintenabilité.
- Il propose une expérience utilisateur réellement différente, pas seulement un nouveau nom ou quelques styles.

Cela garde le marketplace lisible et aide les utilisateurs à choisir.

## Exemple minimal

```json
{
  "id": "your-name.example-plugin",
  "name": "Example Plugin",
  "version": "1.0.0",
  "description": "A short description of what this plugin improves.",
  "author": "your-name",
  "category": "readability",
  "license": "MIT",
  "engine": ">=1.0.0",
  "tier": "declarative",
  "matches": ["https://claude.ai/*"],
  "contributes": {
    "styles": [{ "file": "style.css" }],
    "domOps": [
      {
        "op": "addClass",
        "target": "body",
        "className": "gv-plugin-example"
      }
    ]
  }
}
```

`style.css` peut être écrit comme du CSS normal, mais les styles du plugin doivent rester sous votre propre classe `gv-plugin-*` :

```css
.gv-plugin-example .some-target {
  max-width: 880px;
}
```

## Notes sur le manifest

- Utilisez un préfixe d'auteur ou un style de domaine inversé pour `id`, par exemple `your-name.reading-width`, afin d'éviter les collisions.
- Gardez `matches` aussi précis que possible. Ne ciblez que les sites où le plugin doit vraiment fonctionner.
- Un même plugin peut contenir plusieurs `matches` si ces plateformes partagent un objectif fonctionnel clair.
- Valeurs recommandées pour `category` : `render-fix`, `theme`, `layout`, `readability`, `productivity`, `integration` ou `other`.
- Indiquez dans `engine` la version du moteur de plugins requise. Les plugins officiels peuvent servir d'exemples.
- Ajoutez si possible `i18n` pour le chinois, l'anglais et les autres langues courantes.

## Limites CSS et ressources

Les plugins déclaratifs sont validés comme des entrées non fiables. Gardez donc les ressources autonomes :

- N'utilisez pas `@import`.
- Ne référencez pas d'images distantes, de polices externes ni de CSS distant.
- Vous pouvez utiliser du CSS normal, des propriétés personnalisées et les substitutions de valeurs de réglage fournies par Voyager.
- Préfixez les classes avec `gv-plugin-` pour éviter de polluer le site hôte ou Voyager.

Si le plugin a besoin de réglages, commencez de préférence par des valeurs numériques. Un plugin de largeur de lecture peut par exemple écrire la valeur dans une variable CSS, puis la consommer côté CSS.

## Limites des opérations DOM

Les plugins déclaratifs prennent actuellement en charge :

- `addClass` : ajoute une classe aux éléments ciblés.
- `setAttribute` : définit un attribut.
- `setStyle` : définit un style inline ou une variable CSS.
- `hide` : masque les éléments ciblés.

La cible peut être un sélecteur CSS ou l'une des clés sémantiques listées plus haut, écrite `{ "kind": "semantic", "key": "userTurn" }`. Les clés sémantiques sont souvent plus stables, mais l'adaptateur du site doit déclarer la clé.

Les opérations déclaratives doivent être réversibles et sûres à exécuter plusieurs fois. Ne dépendez pas d'un état ponctuel de la page et ne supposez pas que le DOM ne change jamais.

## Quand éviter un plugin classique

Si une fonctionnalité doit exécuter du JavaScript, intercepter des requêtes, lire ou écrire des données internes Voyager, ou dépendre d'une logique d'exécution complexe, elle ne convient pas à un plugin déclaratif classique.

Ouvrez d'abord une Issue pour expliquer le besoin. Si une capacité intégrée est vraiment nécessaire, nous pourrons envisager une implémentation dans le dépôt Voyager comme plugin builtin/native, par exemple Formula Copy.

## Avant d'ouvrir une PR

- Le plugin est désactivé par défaut et l'utilisateur l'active lui-même.
- Vous avez vérifié qu'il n'existe pas de plugin presque identique ; sinon, améliorez d'abord l'existant.
- Vous avez testé le site cible en thème clair et sombre.
- `matches` ne couvre pas de sites sans rapport.
- Aucune ressource distante n'est référencée.
- Le dossier du plugin contient `plugin.json`, les fichiers CSS nécessaires et un court README.
- Pour un plugin officiel, le dossier se trouve sous `catalog/sites/<site>/plugins/<id>/`, ses `matches` restent dans ceux du site, et `catalog/marketplace.json` le référence.
- La PR décrit les pages de test, captures ou vidéos, ainsi que les zones de page affectées.

Restez simple, ciblé et réversible. Un plugin qui résout un problème clair est beaucoup plus facile à fusionner et maintenir.
