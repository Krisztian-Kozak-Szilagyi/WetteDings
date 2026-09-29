# BfW Holdings – fogadási oldal játékpénzzel

Német nyelvű, reszponzív fogadási oldal. Mindenki 1000 € játékpénzt kap regisztrációkor, bárki kiírhat fogadást, a többiek pedig **ugyanarra az oldalra tehetnek (Mitgehen)** vagy **ellenfogadást köthetnek (Dagegenhalten)**.

**Technológia:** Node.js (Express 5) · MongoDB Atlas (Mongoose) · EJS szerveroldali renderelés · saját CSS (mobil → desktop) · nincs build lépés.

## Hogyan működik a rendszer

- **Két fogadástípus:** *Ja/Nein* (egy állítás igaz-e), vagy **saját opciók** (min. 2, max. 10, pl. „Bayern / Unentschieden / Dortmund“). Közzététel után az opciók nem módosíthatók, új opció nem adható hozzá.
- A kiíró két kötelező időpontot ad meg: **Einsatzschluss** (eddig lehet tétet tenni) és **Auswertung** (ekkor lesz eredményhirdetés; nem lehet korábbi a tét-határidőnél). Mindkettő jól látható a fogadásnál.
- **A kiíró nem tehet a saját fogadására**, cserébe a kassza **5%-át** kapja jutalékként (`CREATOR_FEE_PERCENT`), amikor rögzíti az eredményt. A jutalék a fogadás létrehozásakor rögzül; ha a beállított érték csökken, a még nyitott fogadások induláskor automatikusan az alacsonyabb értékre állnak.
- **Csak tagoknak:** kijelentkezett látogatók semmilyen fogadást (és ranglistát) nem látnak, csak a nyitóoldalt, a szabályokat és a bejelentkezést/regisztrációt. Megosztott fogadás-link bejelentkezés után a fogadásra visz.
- **Élő frissítés:** a fogadáslista, a fogadás oldala és a lottó 5 másodpercenként ellenőrzi, változott-e valami (kis „verzió” lekérdezés), és ha igen, a háttérben frissíti a kasszát, kvótákat, résztvevőket, kommenteket – a beírt adatok (tét, komment) megmaradnak. Ha a fogadás állapota változik (lezárult, eredmény született), az oldal magától újratölt.
- **Lottó:** naponta egy sorsolás. Egy sorsjegy 100 € (`LOTTERY_TICKET_EUR`), több is vehető (max. 10 / vásárlás). Minden sorsjegy sorszámot kap; a húzáskor egy sorszámot sorsol a rendszer (kriptográfiai véletlen), a tulajdonos kapja a teljes kasszát. A húzás a következő napon, mindig 1 perccel a következő lottó kezdete előtt van – alapból húzás 19:59-kor, új kör 20:00-kor (`LOTTERY_TIME=20:00`).
- **Coin Exchange – Samantha Coin (SAM):** játékpénzt lehet befektetni egy szimulált coinba, és bármikor visszaváltani (díj nélkül, az aktuális árfolyamon). Élő grafikon (1 óra / 24 óra / 7 nap / 30 nap / összes), portfólió (érték, átlagár, nyereség/veszteség), saját kötések, piaci események. A coinban lévő érték beszámít a teljes vagyonba (ranglista, napi bónusz).
  - **Árfolyammodell** (`src/coin/model.js`): sztochasztikus volatilitás (nyugodt és vad időszakok), vastag farkú (Student-t) hozamok, játékosan élénk mozgás: kis ugrások kb. 40 percenként, nagyobbak (5–15%, néha 30%+) naponta 1–2 alkalommal, pump (+40…+150%) évente kb. 6–7×, crash (−80…−99%) évente kb. 1×; nagy mozgás után megugrik a volatilitás. A várható hozam enyhén pozitív (~+0,05%/nap), így a coin se nem biztos nyerő, se nem kijátszható.
  - **Admin-vezérlés:** az Admin panelen („Samantha Coin steuern”) megadható egy százalékos változás (−99…+1000%), azonnal vagy 1–60 perc alatt fokozatosan (a normál ingadozással keveredve). Nem jelenik meg a piaci eseményekben, az API-ban vagy a naplóban; fut közben megszakítható, és újraindítás után is folytatódik.
  - **Motor** (`src/coin/engine.js`): a szerverben fut, 5 másodpercenként új ár; percenkénti (3 napig) és óránkénti (örökre) gyertyák a MongoDB-ben. Első induláskor 14 nap előtörténetet szimulál; ha a szerver állt, induláskor utólag lejátssza a kimaradt időt (max. 30 nap), így a grafikon folytonos.
- **TCG (Trading Cards):** booster pack 80 € (`TCG_PACK_EUR`), 3 kártyával. Animált nyitás (tasak feltépése, kártyák felfordítása, a legritkább kártya jön utoljára), gyűjtemény szűrővel, a még meg nem szerzett kártyák helye „?”-lel látszik, kattintásra nagyítás 3D-s döntéssel és holo/gold/glitch effekttel, eladás egyesével vagy az összes duplikátum egyszerre.
  - **Esélyek kártyánként** (`src/tcg/catalog.js`): Crumpled 58,12% · BFWler 28% · Gold 11% · Holo 2,5% · Bockhaber 0,3% · Glitch 0,08%. Előbb a ritkaságot sorsolja (kriptográfiai véletlen), utána azon belül egyenletes eséllyel egy kártyát.
  - **Eladási ár:** 5 € / 20 € / 40 € / 150 € / 1 000 € / 3 000 €. Egy pack várható értéke kb. 66,17 € (a 80 €-s ár ~83%-a), tehát hosszú távon nem nyereséges; 2× Crumpled + 1× BFWler = 30 €. Ha az árakat vagy esélyeket módosítod, a teszt jelez, ha a pack nyereségessé válna.
  - **Admin panel → „TCG: Chancen & Preise”:** a pack ára, a 6 ritkaság esélye (%-ban, 2 tizedesjegyig, összesen pontosan 100%) és eladási ára szerkeszthető. Azonnal érvényes, és a MongoDB-ben (`tcgsettings`) tárolódik, így újraindítás után is megmarad. A panel élőben mutatja az esélyek összegét és a pack várható értékét, és figyelmeztet, ha nyereséges lenne. A kódban lévő értékek (`catalog.js`, `TCG_PACK_EUR`) csak alapértelmezések, amíg nincs mentett beállítás.
  - **Admin panel → Samantha Coin steuern:** rejtett felugró ablak; a „Registrierungscodes” szövegében az „automatisch” szóra kattintva nyílik meg. A kártyák eladási értéke beszámít a teljes vagyonba (ranglista, napi bónusz).
- **Support-bot („Warren Buffett”):** lebegő chat gomb jobb alul (csak bejelentkezve). Csak az oldallal kapcsolatos kérdésekre válaszol, és csak azt tudja, amit egy felhasználó is lát (`src/support/knowledge.js`; az aktuális árakat/esélyeket élőben olvassa be). Groq API (`GROQ_API_KEY` a `.env`-ben; üresen a chat rejtve van), modellek sorban: `openai/gpt-oss-120b` → `openai/gpt-oss-20b` → `qwen/qwen3.8-27b` (mindegyiknek külön ingyenes percenkénti token-limitje van). Felhasználónként max. 30 üzenet/óra; az előzmények a sessionben tárolódnak (↺ = új beszélgetés).
  - **Kártyák = képfájlok** a `public/img/tcg` mappában, `<név>[-<szám>]-<ritkaság>.png` névvel (pl. `krisz-6-glitch.png`, `bfw-energy-gold.png`). Új kártyához elég bemásolni a fájlt és újraindítani a szervert.
- Mások határidőig tehetnek bármelyik opcióra. Egy fogadáson belül mindenki csak **egy opcióra** tehet, de a tétjét emelheti.
- **Totalizátor (pari-mutuel) elszámolás:** az összes tét egy kasszába kerül. A jutalék levonása után a maradékon a nyerő opcióra tevők osztoznak, **a saját tétjük arányában**.
- Kvóta = (kassza − jutalék) ÷ az adott opció tétjei (élőben kiszámolva, a tét-űrlapon a várható nyereményt is mutatja).
- **Speciális esetek** – mindenki visszakapja a tétjét, jutalék nélkül: ha nem volt ellenoldal, ha senki nem tett a nyerő opcióra, vagy ha a fogadást érvénytelenítik (annullieren).
- A cent-kerekítést a legnagyobb maradék módszerrel osztja el, így a kifizetések és a jutalék összege **mindig pontosan** a kassza.
- Az eredményt a **kiíró bármikor** rögzítheti (akár a határidő előtt is – ekkor a fogadás azonnal lezárul), de **kötelező indoklást** írnia (pl. végeredmény + forrás), ami utólag is látható. Érvénytelenítésnél is kötelező az indoklás. Az **adminok** (`ADMIN_USERNAMES`) bármelyik fogadást eldönthetik/érvényteleníthetik. Ha a határidő után 14 napig (`AUTO_VOID_DAYS`) nincs eredmény, a rendszer automatikusan érvényteleníti és visszatéríti.
- **Szerkesztés:** a leírást a kiíró utólag módosíthatja (amíg a fogadás nyitott), a címet csak admin. Minden változás bekerül a fogadás nyilvános változástörténetébe.
- **Teilen gomb:** a fogadás linkjét a vágólapra másolja.
- **Napi bónusz:** ha a teljes vagyon (szabad egyenleg + nyitott tétek) 500 € alatt van, naponta +150 €, 500–1000 € között +100 €, 1000 €-tól nincs bónusz. A nap első látogatásakor (német idő) automatikusan jóváíródik, és megjelenik a kivonatban. A sávok a `src/config.js`-ben (`bonusTiers`) állíthatók.
- **Regisztráció csak kóddal:** az adminok az **Admin** menüpontban (`/admin`) generálnak kódot (formátum `XXXX-XXXX`). Egy kód **30 percig** érvényes és **egyetlen** regisztrációra használható, utána megsemmisül. Vészhelyzetre (pl. nincs admin) a szerveren: `node scripts/create-code.js`.
- **Kommentek:** minden fogadás alatt beszélgetés; a kiíró és a résztvevők (a választott opcióval) jelölve vannak. Saját komment törölhető, admin bármelyiket eltávolíthatja; percenként max. 6 komment/felhasználó.
- Minden pénzmozgás **MongoDB tranzakcióban** történik (nem lehet dupla költés, negatív egyenleg vagy kétszeres kifizetés), és bekerül a felhasználó számlakivonatába (Kontoauszug).

**Oldalak:** Wetten (lista szűrőkkel + keresés), Wette-részletek, Neue Wette, Mein Konto (egyenleg, statisztika, kivonat, jelszócsere), Rangliste, Coin Exchange, Lotterie, TCG, Regeln (magatartási szabályok + működés), Impressum, Datenschutz.

**Biztonság:** bcrypt jelszó-hash, CSRF-token minden űrlapon, rate limit a belépésnél/regisztrációnál, Helmet biztonsági fejlécek (CSP), session a MongoDB-ben, HttpOnly/SameSite/Secure sütik.

---

## 1. MongoDB Atlas beállítása

1. [cloud.mongodb.com](https://cloud.mongodb.com) → hozz létre egy clustert (az ingyenes M0 is elég).
2. **Database Access** → új adatbázis-felhasználó jelszóval (readWrite jog).
3. **Network Access** → add hozzá a **VPS IP-címét** (fejlesztéshez ideiglenesen a saját IP-det is).
4. **Connect → Drivers** → másold ki a connection stringet, és írd bele az adatbázis nevét (`/wettstube`):
   ```
   mongodb+srv://USER:JELSZO@cluster0.xxxxx.mongodb.net/wettstube?retryWrites=true&w=majority
   ```
   Ha a jelszóban speciális karakter van (`@ : / ?` stb.), URL-kódold.

A táblák (collections) és indexek az első indításkor automatikusan létrejönnek.

## 2. Helyi futtatás (opcionális)

```bash
npm install
cp .env.example .env      # töltsd ki: MONGODB_URI, SESSION_SECRET; NODE_ENV=development, COOKIE_SECURE=false
npm run dev               # http://localhost:3000
npm test                  # elszámolási logika tesztjei
```

## 3. Telepítés VPS-re (Ubuntu/Debian)

### 3.1 Szoftverek
```bash
sudo apt update && sudo apt install -y nginx git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 3.2 Kód feltöltése
Git-tel (`git clone … /var/www/wettstube`) vagy a mappát másold fel, pl.:
```bash
scp -r wettstube user@VPS_IP:/var/www/
```
(`node_modules` és `.env` nélkül.)

### 3.3 Konfiguráció és indítás
```bash
cd /var/www/wettstube
npm ci --omit=dev
cp .env.example .env
nano .env
```
Töltsd ki legalább:
- `MONGODB_URI` – az Atlas string
- `SESSION_SECRET` – generálj egyet: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `ADMIN_USERNAMES` – a saját felhasználóneved (regisztráció után)
- `COOKIE_SECURE=false` **amíg nincs HTTPS**, utána `true`!

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # a kiírt parancsot futtasd le, így újraindítás után is elindul
pm2 logs wettstube # itt látod, ha valami nem jó (pl. Atlas IP nincs engedélyezve)
```

### 3.4 Nginx + HTTPS
```bash
sudo cp deploy/nginx-wettstube.conf /etc/nginx/sites-available/wettstube
sudo nano /etc/nginx/sites-available/wettstube      # example.de -> a domained
sudo ln -s /etc/nginx/sites-available/wettstube /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d deinedomain.de -d www.deinedomain.de
```
Ezután `.env`-ben `COOKIE_SECURE=true`, majd `pm2 restart wettstube`.

Tűzfal (ha van): `sudo ufw allow 'Nginx Full' && sudo ufw allow OpenSSH`.

### 3.5 Frissítés
```bash
cd /var/www/wettstube
git pull            # vagy új fájlok feltöltése
npm ci --omit=dev
pm2 restart wettstube
```

## Beállítások (.env)

| Változó | Alapérték | Jelentés |
|---|---|---|
| `MONGODB_URI` | – | Atlas connection string (kötelező) |
| `SESSION_SECRET` | – | hosszú véletlen string (kötelező, prod-ban min. 32 karakter) |
| `APP_NAME` | BfW Holdings | az oldal neve |
| `START_BALANCE_EUR` | 1000 | kezdő játékpénz |
| `MIN_STAKE_EUR` | 1 | minimális tét |
| `ADMIN_USERNAMES` | – | vesszővel elválasztott admin felhasználónevek |
| `CREATOR_FEE_PERCENT` | 5 | a kiíró jutaléka a kasszából (%) – csak az új fogadásokra |
| `AUTO_VOID_DAYS` | 14 | ennyi nap után automatikus érvénytelenítés, ha nincs eredmény |
| `COOKIE_SECURE` | prod-ban true | HTTPS nélkül `false` kell |
| `TRUST_PROXY` | prod-ban 1 | proxyk száma az app előtt (Nginx = 1) |
| `PORT` / `HOST` | 3000 / 127.0.0.1 | csak lokálisan figyel, kívülről az Nginx éri el |

## Élesítés előtt

- **Impressum és Datenschutz**: a `views/impressum.ejs` és `views/datenschutz.ejs` fájlokban helyőrzők vannak – töltsd ki a saját adataiddal.
- Atlas-ban érdemes bekapcsolni a biztonsági mentést (M0-n nincs automatikus backup – ott `mongodump`-pal időnként menthetsz).

## Projektstruktúra

```
server.js                 indítás, DB-kapcsolat, graceful shutdown
src/config.js             .env beolvasása
src/app.js                Express, biztonság, session, route-ok
src/lib/payout.js         kifizetés-számítás (totalizátor)
src/services/betService.js  tranzakciók: regisztráció, fogadás, tét, lezárás
src/models/               User, Bet, Position (tét), Ledger (számlakivonat)
src/routes/               oldalak
src/jobs.js               lejárt fogadások automatikus érvénytelenítése
src/tcg/                  TCG: kártyakatalógus + esélyek (catalog.js), packnyitás/eladás (tcgService.js)
public/img/tcg/           kártya- és booster-pack képek
views/                    EJS sablonok (német szöveg)
public/                   CSS, JS, favicon
deploy/                   Nginx konfiguráció
ecosystem.config.js       PM2 konfiguráció
```
