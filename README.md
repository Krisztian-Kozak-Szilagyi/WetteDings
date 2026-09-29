# Wettstube – fogadási oldal játékpénzzel

Német nyelvű, reszponzív fogadási oldal. Mindenki 1000 € játékpénzt kap regisztrációkor, bárki kiírhat fogadást, a többiek pedig **ugyanarra az oldalra tehetnek (Mitgehen)** vagy **ellenfogadást köthetnek (Dagegenhalten)**.

**Technológia:** Node.js (Express 5) · MongoDB Atlas (Mongoose) · EJS szerveroldali renderelés · saját CSS (mobil → desktop) · nincs build lépés.

## Hogyan működik a rendszer

- **Fogadás = állítás**, amit később egyértelműen *Ja* vagy *Nein* dönt el (pl. „Bayern gewinnt am Samstag“).
- A kiíró megad egy **Einsatzschluss**-t (tét-határidőt), és elsőként ő tesz egy tétet valamelyik oldalra.
- Mások határidőig tehetnek ugyanarra vagy az ellenkező oldalra. Egy fogadáson belül mindenki csak **egy oldalra** tehet, de a tétjét emelheti.
- **Totalizátor (pari-mutuel) elszámolás:** az összes tét egy kasszába kerül. A nyertes oldalon mindenki visszakapja a tétjét, **plusz a vesztes oldal teljes tétjéből a saját tétje arányában részesedik**. Nincs jutalék, semmi nem vész el.
- Kvóta = kassza ÷ az adott oldal tétjei (élőben kiszámolva, a tét-űrlapon a várható nyereményt is mutatja).
- **Speciális esetek** – mindenki visszakapja a tétjét: ha nem volt ellenoldal, ha senki nem tett a nyerő oldalra, vagy ha a fogadást érvénytelenítik (annullieren).
- A cent-kerekítést a legnagyobb maradék módszerrel osztja el, így a kifizetések összege **mindig pontosan** a kassza.
- Határidő után a **kiíró** rögzíti az eredményt; az **adminok** (`ADMIN_USERNAMES`) bármelyik fogadást eldönthetik/érvényteleníthetik. Ha 14 napig (`AUTO_VOID_DAYS`) nincs eredmény, a rendszer automatikusan érvényteleníti és visszatéríti.
- Minden pénzmozgás **MongoDB tranzakcióban** történik (nem lehet dupla költés, negatív egyenleg vagy kétszeres kifizetés), és bekerül a felhasználó számlakivonatába (Kontoauszug).

**Oldalak:** Wetten (lista szűrőkkel + keresés), Wette-részletek, Neue Wette, Mein Konto (egyenleg, statisztika, kivonat, jelszócsere), Rangliste, So geht's (szabályok), Impressum, Datenschutz.

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
| `APP_NAME` | Wettstube | az oldal neve |
| `START_BALANCE_EUR` | 1000 | kezdő játékpénz |
| `MIN_STAKE_EUR` | 1 | minimális tét |
| `ADMIN_USERNAMES` | – | vesszővel elválasztott admin felhasználónevek |
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
views/                    EJS sablonok (német szöveg)
public/                   CSS, JS, favicon
deploy/                   Nginx konfiguráció
ecosystem.config.js       PM2 konfiguráció
```
