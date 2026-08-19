# Peinture et retouche, ce qui reste

Etat de la branche `feat/retopo-guides` et ce qu'il faudrait faire ensuite. Ce
document existe pour qu'une reprise ne demande pas de relire tout le code, et il
dit surtout les pieges deja identifies, qui sont la partie couteuse a
redecouvrir.

## Ce qui marche

Quatre pinceaux et un tampon, dans la barre au-dessus du modele. Ils ecrivent sur
les points soudes du maillage, pas sur les sommets de rendu: une couture d'UV
dedouble une position, et un pinceau qui l'ignore laisse un fil non peint
qu'aucun passage ne comble.

- **Densite** de -1 a +1, ou les triangles valent la peine.
- **Geler**, jamais touche.
- **Zone**, la seule partie que le calcul a le droit de modifier.
- **Guides**, un pli a tenir ou un sens de boucles a suivre.
- **Tampon**, Alt-clic pose la source, peindre recopie la couleur de base.

Cote moteur: la densite pondere le cout d'un effondrement d'arete et pilote la
longueur d'arete locale du remesh isotrope, le gel et la zone verrouillent des
points, un guide de pli verrouille la ligne, un guide de flux biaise quelles
aretes sont depensees. Le bake sait garder les UV du resultat au lieu de le
redeplier, donc une seconde cuisson est une correction et non un remplacement, et
une retouche ne recuit que la zone peinte en la fondant dans l'existant.

## Le maillon jamais verifie de bout en bout

**Le trajet Tauri vers le processus enfant pour le fichier `.paint`.** Il est
teste des deux cotes, jamais d'un bout a l'autre dans l'application compilee.

Ce qui le prouvera en une minute: peindre une zone, lancer une decimation, et
lire la ligne **Peinture retrouvee** du bilan. Deux nombres identiques veulent
dire que le sidecar est arrive. Pour la retouche, c'est la ligne **Texels
retouches** et sa part de l'atlas.

Si ca ne passe pas, les trois endroits a regarder dans l'ordre:

1. `inputForMesh` dans `src/retopo/index.js` ecrit `<input>.paint` a cote du GLB
   exporte. Le chemin rapide qui donne le fichier d'origine au moteur est
   desactive des qu'il y a de la peinture, sinon le sidecar irait se poser dans
   le dossier de l'utilisateur.
2. `bake_args` et `retopo_decimate` dans `src-tauri/src/retopo.rs` ecrivent la
   ligne de commande de l'enfant. **Tout champ ajoute a `RemeshRequest` doit y
   etre epele**, sinon il n'arrive jamais: c'est le mode de panne le plus
   silencieux du projet, un reglage qui bouge dans l'interface et ne change rien
   au resultat.
3. `Painting::load` dans `retopo-core`. Un fichier absent est normal, un fichier
   illisible est une erreur, et c'est voulu: un pinceau qui ne fait rien en
   silence ne se distingue pas d'un pinceau casse.

## Les pieges deja payes

A ne pas redecouvrir.

**La peinture voyage en points dans l'espace, pas en tableau indexe par sommet.**
Entre three.js et le lecteur glTF il y a un export, une concatenation de
primitives, une soudure et une purge de degeneres. Une numerotation qui glisse ne
produit pas une erreur, elle produit un masque plausible applique au mauvais
endroit, ce qui est la pire forme qu'un bug puisse prendre dans un outil dont on
juge le resultat a l'oeil.

**La zone se demande a l'echelle du maillage qui pose la question.** La peinture
est faite sur le high poly, le bake demande a propos du low poly, et leurs
sommets ne coincident pas. Avec le rayon d'appariement du sidecar, qui vaut un
quart d'arete du maillage peint, une zone couvrant toute une oreille repond
dehors pour chaque triangle du low poly et la retouche sort vide. D'ou
`in_region_within`.

**Le pick doit passer par la hierarchie, y compris pour les maillages skinnes.**
`Raycaster.intersectObject` est lineaire: 18 ms par appel sur 31 000 triangles,
appele pour chaque evenement, chaque echantillon coalesce et chaque pas de
remplissage. Un maillage rigge renvoye vers ce chemin annule toute
l'acceleration, et c'est ce qui est arrive a la premiere version. Le BVH se
construit sur les positions **posees**: la pose de liaison n'est pas ce qui est a
l'ecran.

**Un etat qui appartient a la facon de regarder le modele ne doit pas rester sur
le modele.** `uPaint` est un uniform sur les materiaux, et les materiaux
survivent a la barre du mode: la peinture restait dessinee apres la fermeture,
sans rien a l'ecran pour dire pourquoi. C'est le meme piege que `uSide` avec le
rideau de comparaison, deja documente dans `wire.js`, et je l'ai refait quand
meme.

**Le remesh isotrope tirait son ordre d'aretes d'une `HashMap`.** Deux runs
identiques rendaient 846 puis 856 triangles. Trie desormais. Toute nouvelle
etape gloutonne doit se poser la meme question.

## Ce qui reste a faire

### Le tampon, ce qu'il ne fait pas encore

- **Il ne recopie que la couleur de base.** Un tampon sur une carte de normales
  ecrit des vecteurs qui appartiennent a un autre endroit de la surface. Si on le
  veut vraiment, il faut transformer l'echantillon du repere tangent de la source
  vers celui de la destination, pas le copier.
- **Le decalage est mesure dans l'espace texture.** Juste a l'interieur d'un
  ilot, faux des qu'on traverse une couture. Un decalage en 3D demanderait une
  requete de point le plus proche sur la surface, que le BVH ne fournit pas
  encore. En attendant, il vaudrait mieux **detecter** la traversee d'ilot et le
  dire plutot que de peindre n'importe quoi.
- **Pas de fondu au bord du trait cote texture.** La brosse a bien un adoucis,
  mais deux passages se voient encore.

### Ce qui manque autour

- **Sauver la peinture avec le document.** Elle vit en memoire et disparait avec
  l'onglet. Le format existe deja, c'est celui du sidecar.
- **Un apercu de la zone avant de lancer.** Le rapport dit apres coup combien de
  texels ont ete retouches. Le dire avant eviterait un calcul pour rien.
- **La symetrie ne connait qu'un plan par le milieu du modele.** Un modele
  authoring hors centre voudra un plan reglable.
- **Le tampon ne suit pas la symetrie de maniere utile.** Il fonctionne, mais
  copier une source miroitee demanderait de miroiter aussi le decalage en UV, ce
  qui n'a de sens que si l'atlas est lui-meme symetrique. A ce jour le second
  passage recopie la meme source.

### Limites de fond, a ne pas prendre pour des bugs

- Une retouche n'a de sens que sur un maillage deja cuit et **non modifie
  depuis**. Si la geometrie a bouge, l'atlas ne decrit plus rien.
- Changer la taille de l'atlas pendant une retouche est refuse. La disposition
  suivrait, puisque les coordonnees sont normalisees, mais toute l'ancienne image
  devrait etre reechantillonnee et ce ne serait plus la texture contre laquelle
  le reste du modele a ete juge.
- Un guide de flux est la moitie pauvre de ce qu'un remailleur aligne sur un
  champ fait vraiment. Il garde les aretes qui suivent la courbe et depense
  celles qui la traversent. C'est utile et ce n'est pas de la remaille dirigee.

## Comment lancer la branche

Le worktree est separe pour ne pas gener une autre branche du meme depot, et il
compile dans son propre dossier `target`.

```
cd C:/DEV/coding/Github/Albedo-guides
npm run tauri dev
```
