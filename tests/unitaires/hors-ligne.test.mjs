// Vérifie que l'application peut fonctionner hors ligne : chaque fichier
// utilisé par l'application doit figurer dans la liste du service worker
// (sw.js), et chaque fichier de la liste doit exister.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const RACINE = fileURLToPath(new URL('../..', import.meta.url));
const lire = (chemin) => readFileSync(join(RACINE, chemin), 'utf8');

/** Liste des fichiers mis en cache par sw.js. */
function fichiersDuServiceWorker() {
  const liste = /const FICHIERS = \[([\s\S]*?)\];/.exec(lire('sw.js'))[1];
  return [...liste.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Tous les fichiers d'un dossier (récursivement), chemins relatifs à la racine. */
function fichiersDe(dossier) {
  const resultat = [];
  const parcourir = (chemin) => {
    for (const nom of readdirSync(chemin)) {
      const complet = join(chemin, nom);
      if (statSync(complet).isDirectory()) parcourir(complet);
      else resultat.push(relative(RACINE, complet).split('\\').join('/'));
    }
  };
  parcourir(join(RACINE, dossier));
  return resultat;
}

test('chaque fichier de la liste hors ligne existe', () => {
  for (const fichier of fichiersDuServiceWorker()) {
    if (fichier === './') continue;
    assert.ok(existsSync(join(RACINE, fichier)), `${fichier} est dans sw.js mais n'existe pas`);
  }
});

test('chaque fichier de l’application est dans la liste hors ligne', () => {
  const liste = new Set(fichiersDuServiceWorker());
  const attendus = [
    'index.html',
    'manifest.webmanifest',
    ...fichiersDe('css'),
    ...fichiersDe('js'),
    ...fichiersDe('fonts'),
    ...fichiersDe('icons'),
    ...fichiersDe('assets'),
    ...fichiersDe('licences'),
    'vendor/fast-formula-parser/parser.min.js',
  ];
  for (const fichier of attendus) assert.ok(liste.has(fichier), `${fichier} manque dans la liste de sw.js`);
});

test('le manifeste et config.js donnent le même nom', () => {
  const manifeste = JSON.parse(lire('manifest.webmanifest'));
  const nom = /nom: '([^']+)'/.exec(lire('js/config.js'))[1];
  assert.equal(manifeste.name, nom);
  assert.equal(manifeste.short_name, nom);
  for (const icone of manifeste.icons) assert.ok(existsSync(join(RACINE, icone.src)), `${icone.src} introuvable`);
});

test('index.html ne charge rien depuis internet', () => {
  const page = lire('index.html');
  const adresses = [...page.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
  for (const adresse of adresses) {
    if (adresse.startsWith('mailto:')) {
      // Lien « écrire un e-mail » (À propos) : il ouvre la messagerie, rien n'est chargé.
      assert.match(adresse, /^mailto:omni-systeme\.choking513@passmail\.net\?subject=/, `adresse e-mail inattendue : ${adresse}`);
    } else if (adresse.startsWith('http')) {
      // Seuls des liens ouverts à la demande sont permis : le site de
      // l'Omni-système et le résumé de la licence chez Creative Commons.
      assert.match(adresse, /^https:\/\/(ferrusdantioch\.github\.io|creativecommons\.org)\//, `ressource externe : ${adresse}`);
    } else {
      assert.ok(existsSync(join(RACINE, adresse)), `fichier introuvable : ${adresse}`);
    }
  }
});

test('la version 2.2.4 est unifiée entre config.js, package.json, package-lock.json, README.md et sw.js', () => {
  const versionConfig = /version:\s*'([^']+)'/.exec(lire('js/config.js'))[1];
  const pkg = JSON.parse(lire('package.json'));
  const lock = JSON.parse(lire('package-lock.json'));
  const readme = lire('README.md');
  const sw = lire('sw.js');

  assert.equal(versionConfig, '2.2.4');
  assert.equal(pkg.version, '2.2.4');
  assert.equal(lock.version, '2.2.4');
  assert.equal(lock.packages[''].version, '2.2.4');
  assert.match(readme, /2\.2\.4/);
  assert.match(sw, /const CACHE = `\$\{PREFIXE\}\$\{CONFIG\.version\}`;/);
  assert.match(sw, /omni-tableur-2\.2\.4/);
});

test('sw.js vérifie le cache exact avant navigate et renvoie 503 hors ligne', async () => {
  const scope = 'https://ferrusdantioch.github.io/omni-tableur/';
  const ecouteurs = new Map();
  const stockCaches = new Map();

  class FausseReponse {
    constructor(corps, init = {}) {
      this._corps = corps;
      this.status = init.status ?? 200;
      this.statusText = init.statusText ?? 'OK';
      this.headers = init.headers ?? {};
    }
    async text() {
      return String(this._corps);
    }
  }

  const obtenirCache = (nom) => {
    if (!stockCaches.has(nom)) stockCaches.set(nom, new Map());
    const table = stockCaches.get(nom);
    return {
      async match(requete, options = {}) {
        const brut = typeof requete === 'string' ? requete : requete.url;
        if (table.has(brut)) return table.get(brut);
        const u = new URL(brut, scope);
        let rel = u.href.startsWith(scope) ? u.href.slice(scope.length) : u.pathname.replace(/^\//, '');
        if (options.ignoreSearch) rel = rel.split('?')[0];
        if (rel === '' || rel === './') return table.get('./') ?? null;
        return table.get(rel) ?? null;
      },
      async addAll() {},
    };
  };

  const contexte = vm.createContext({
    URL,
    Response: FausseReponse,
    Request: class FausseRequete {
      constructor(url, init = {}) {
        this.url = url;
        this.method = init.method ?? 'GET';
        this.mode = init.mode ?? 'cors';
      }
    },
    caches: {
      async open(nom) {
        return obtenirCache(nom);
      },
      async keys() {
        return [...stockCaches.keys()];
      },
      async delete(nom) {
        return stockCaches.delete(nom);
      },
    },
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
    importScripts(...fichiers) {
      for (const f of fichiers) vm.runInContext(lire(f), contexte, { filename: f });
    },
  });
  contexte.self = contexte;
  contexte.registration = { scope };
  contexte.location = { origin: new URL(scope).origin };
  contexte.addEventListener = (type, fn) => ecouteurs.set(type, fn);

  vm.runInContext(lire('sw.js'), contexte, { filename: 'sw.js' });

  const cache = obtenirCache('omni-tableur-2.2.4');
  // Pré-remplir le cache avec l'application et un fichier de licence.
  stockCaches.get('omni-tableur-2.2.4').set('./', new FausseReponse('<html>index</html>'));
  stockCaches.get('omni-tableur-2.2.4').set('index.html', new FausseReponse('<html>index</html>'));
  stockCaches.get('omni-tableur-2.2.4').set('licences/fast-formula-parser-MIT.txt', new FausseReponse('MIT License'));

  const gestionnaireFetch = ecouteurs.get('fetch');
  assert.equal(typeof gestionnaireFetch, 'function');

  const simulerRequete = async (url, mode) => {
    let promesseReponse;
    gestionnaireFetch({
      request: { url, method: 'GET', mode },
      respondWith(p) {
        promesseReponse = p;
      },
    });
    return promesseReponse;
  };

  const repLicence = await simulerRequete(`${scope}licences/fast-formula-parser-MIT.txt?v=1`, 'navigate');
  assert.equal(repLicence.status, 200);
  assert.equal(await repLicence.text(), 'MIT License');

  const repInconnueNav = await simulerRequete(`${scope}route-inconnue`, 'navigate');
  assert.equal(repInconnueNav.status, 200);
  assert.equal(await repInconnueNav.text(), '<html>index</html>');

  const repHorsLigne = await simulerRequete(`${scope}absent.png`, 'no-cors');
  assert.equal(repHorsLigne.status, 503);
  assert.ok(cache);
});

test('les fichiers de dépôt (.gitattributes, .nojekyll, workflow CI) sont présents et conformes', () => {
  assert.ok(existsSync(join(RACINE, '.gitattributes')));
  assert.match(lire('.gitattributes'), /\* text=auto eol=lf/);

  assert.ok(existsSync(join(RACINE, '.nojekyll')));
  assert.equal(statSync(join(RACINE, '.nojekyll')).size, 0);

  const workflow = join(RACINE, '.github/workflows/tests.yml');
  assert.ok(existsSync(workflow));
  const contenuWorkflow = lire('.github/workflows/tests.yml');
  assert.match(contenuWorkflow, /ubuntu-24\.04/);
  assert.match(contenuWorkflow, /npm test/);
  assert.match(contenuWorkflow, /npm run test:navigateur/);
});
