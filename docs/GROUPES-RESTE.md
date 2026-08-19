# Groupes: ce qui reste a faire

Etat de la branche `polygroups` au moment ou elle part sur GitHub, et ce qui
n'est pas fini. Ecrit pour que la reprise ne demande pas de relire tout le code.

Le comment et le pourquoi sont dans [GROUPES.md](GROUPES.md). Ce fichier ne dit
que ce qui manque.

---

## Ce qui marche et a ete mesure

| | Preuve |
| --- | --- |
| Moteur `retopo-segment` | 24 tests, dont un qui epingle le signe du diedre plutot que de croire le commentaire amont |
| Ligne de commande `albedo segment` | cinq modeles reels, rapports et tailles de sidecars concordants |
| Curseur des groupes | 0,42 ms pour rejouer 15 428 superfaces |
| Curseur des familles | 134 parts connexes vers 24, 18, 10, 7, 3, 2 selon la tolerance, 2,1 ms par mouvement |
| Quatre affichages | 14 teintes sans overlay, 101 en aplats, 117 pixels en contours seuls |
| Decoupe en meshes | 2 882 triangles avant, apres et apres annulation, dans les deux modes |
| Selection au clic | clic, ctrl-clic, bascule, inversion, vidage donnent 1, 2, 1, 132, 0 sur 133 groupes |
| Carte d'identite | une par atlas, bords durs, groupes perdus au recouvrement UV comptes et signales |
| Passerelle d'etiquettes | 150 etiquettes importees donnent un plancher de 150 |

---

## Ce qui manque, par ordre d'interet

### 1. La fonction de diametre local (SDF)

Le poids existe et lit zero, la case est prete dans `SegmentOptions`, la passe
n'est pas ecrite. C'est la seule feature classique absente, et c'est celle qui
separe un membre fin du corps epais d'ou il sort.

A ecrire dans `retopo-segment`, sur les **superfaces** et pas sur les faces
brutes: 20 000 superfaces fois 30 rayons font 600 000 lancers, contre 15 millions
sur les faces, pour la meme information. `rayon` est deja une dependance des
crates du moteur et `Bvh` est `Sync`.

Deux pieges connus: partir avec un `t_min` decale vers l'interieur, sinon le
rayon touche sa propre face a t proche de zero; et plafonner les rayons qui
s'echappent, parce qu'un maillage IA est rarement etanche et qu'un rayon perdu
doit compter comme epais et pas comme nul.

Une mediane sur N rayons normalisee par la diagonale de la boite vaut environ
90 % de la chaine complete de Shapira. Le rejet d'aberrants, la ponderation
angulaire et la normalisation logarithmique peuvent attendre.

### 2. L'edition d'un groupe a la main

Le clic selectionne, la selection se decoupe. Ce qui manque est de **modifier**
la partition: fusionner deux groupes retenus, separer un groupe en deux le long
d'une arete, peindre une frontiere au pinceau.

La difficulte n'est pas technique, elle est d'etat. Bouger un curseur renumerote
tout, donc la selection est videe aujourd'hui. Une edition manuelle ne peut pas
etre videe de la meme facon: il faut geler le resultat automatique en une table
`clusterOfSuper` editable a la premiere edition, et griser le curseur avec un
retour explicite a l'automatique. Sans ce gel, un curseur bouge apres une fusion
manuelle produit un etat que personne ne peut predire.

### 3. Le decodage WebP dans le lecteur du moteur

Meshy ecrit ses atlas en WebP et le lecteur fait PNG et JPEG. Le chemin de
l'application n'est pas concerne, la scene partant par un export three.js qui
ecrit du PNG, et c'est mesure. Mais la ligne de commande refuse ces fichiers.

Le champ `source` est deja remonte depuis `EXT_texture_webp` par
`glb/compat.rs`, donc il ne manque que le decodage. Le crate `gltf` ne decode
que PNG et JPEG et n'a pas de crochet, donc il faudrait soit decoder les images
nous-memes apres l'import geometrique, soit reecrire le tampon en PNG avant de
le lui passer. La seconde est plus simple et decale les vues de tampon.

### 4. Un mesh, plusieurs materiaux

La decoupe produit des objets freres. Garder un seul objet en lui donnant N
materiaux demande d'ecrire `geometry.groups`, ce que rien dans ce depot ne fait
aujourd'hui, et de reordonner l'index pour que les triangles d'un groupe soient
contigus.

Un piege identifie et non resolu: `channels.original` est indexe par maillage et
`remember()` n'ecrit que si la cle est absente, donc passer un maillage d'un
materiau unique a un tableau ne sera pas vu, et la passe suivante remettra le
materiau d'origine. Il faut ecrire `channels.original` a la main avant
d'appeler `channels.apply`.

### 5. Le SDF et les poids en direct

Les reglages relancent le moteur sur le GLB deja exporte, ce qui coute quelques
centiemes de seconde sur un petit modele et quelques secondes sur 700 000
triangles. Pour que ce soit vraiment par frame il faudrait sortir le graphe de
regions vers le navigateur et y refaire la fusion, environ 200 lignes. Les
tolerances de pre-fusion resteraient cote moteur, puisqu'elles decident des
superfaces elles-memes.

### 6. Persistance des reglages

Comme le mode Retopo, les reglages vivent dans les `input` du DOM et rien n'est
retenu d'un lancement a l'autre. Si on veut les garder, il faut ajouter les cles
a `DEFAULTS` dans `src/prefs.js`, qui est une **liste blanche en lecture**: une
cle absente est ecrite et jamais relue.

---

## Limites de fond, a ne pas prendre pour des bugs

- **Le plancher du curseur est topologique.** Deux morceaux disjoints ne
  partagent aucune arete, donc aucune fusion ne les reunira. C'est pourquoi le
  curseur des familles existe.
- **Une carte d'identite ne peut pas representer des UV qui se recouvrent.** Sur
  un modele qui reutilise son espace UV, deux parts partageant des texels ne
  peuvent pas y figurer separement. Compte et signale; la decoupe est la reponse
  pour celles-la.
- **Un modele sans texture de couleur** s'effondre en une famille des la plus
  petite tolerance, parce que toutes ses superfaces portent la couleur plate de
  leur materiau. Le panneau le dit.
- **Au-dela de 2 500 parts** le regroupement par apparence est abandonne:
  l'appariement est quadratique et la question n'a plus de sens a cette echelle.

---

## Verification avant de merger

```
cargo test --manifest-path src-tauri/crates/retopo-segment/Cargo.toml
cargo test --manifest-path src-tauri/crates/retopo-core/Cargo.toml
```

Puis, dans l'application, la seule non-regression qui compte vraiment: ouvrir
**Retopo** apres **Groupes**, lancer une decimation et verifier que l'export GLB
n'est pas refuse par le lecteur Rust. C'est le test qui attrape un
`WIRE_ATTRIBUTES` incomplet, lequel casserait la retopologie et pas les groupes.

Verifier aussi que l'overlay survit a un changement de canal d'inspection et a un
aller-retour d'onglet.
