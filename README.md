# BfW Holdings – Wettplattform mit Spielgeld

Deutschsprachige, responsive Wett- und Spielplattform für eine geschlossene Gruppe. Jedes Mitglied startet mit 1.000 € Spielgeld, kann eigene Wetten aufstellen, bei den Wetten anderer **mitgehen** oder **dagegenhalten**, in einen simulierten Coin investieren, an einer täglichen Lotterie teilnehmen und Sammelkarten öffnen. Es wird **kein echtes Geld** verwendet – keine Ein- oder Auszahlungen.

**Technik:** Node.js (Express 5) · MongoDB Atlas (Mongoose) · serverseitiges Rendering mit EJS · eigenes CSS (Mobile First) · kein Build-Schritt.

## Funktionen

### Wetten
- **Zwei Wettarten:** *Ja/Nein* (trifft eine Aussage zu?) oder **eigene Optionen** (2–10, z. B. „Bayern / Unentschieden / Dortmund“). Nach dem Veröffentlichen sind die Optionen fest.
- **Zwei Pflichttermine:** **Einsatzschluss** (bis dahin kann gesetzt werden) und **Auswertung** (Termin der Ergebnisbekanntgabe, nicht vor dem Einsatzschluss). Beide sind auf der Wettseite gut sichtbar.
- **Setzen:** Bis zum Einsatzschluss auf genau eine Option; der Einsatz kann erhöht, die Option aber nicht gewechselt werden.
- **Schiedsrichter (Pflicht):** Beim Aufstellen benennt der Wettersteller ein weiteres Mitglied, das das Ergebnis mit ihm bestätigt (siehe *Ergebnis*). Es ist danach fest.
- **Wettersteller und Schiedsrichter setzen nicht mit.** Dafür teilen sie sich **8 % vom Topf** als Provision (`CREATOR_FEE_PERCENT`, gesamt) – je die Hälfte, ein ungerader Cent geht an den Wettersteller. Ausgezahlt wird sie, sobald das Ergebnis feststeht.
- **Totalisator-Abrechnung:** Alle Einsätze landen in einem Topf. Nach Abzug der Provision teilen sich alle, die auf die eingetretene Option gesetzt haben, den Rest – **anteilig nach ihrem Einsatz**.
- **Quote** = (Topf − Provision) ÷ Einsätze auf die Option – live berechnet; beim Setzen wird der voraussichtliche Gewinn angezeigt.
- **Sonderfälle** – alle bekommen ihren Einsatz zurück, ohne Provision: keine Gegenseite, niemand auf der Gewinner-Option oder Annullierung.
- **Rundungscents** werden nach dem Größter-Rest-Verfahren verteilt – Auszahlungen und Provision ergeben immer **exakt** den Topf.
- **Ergebnis im Vier-Augen-Prinzip:** Wettersteller **und** Schiedsrichter tragen beide ein, was eingetreten ist – jeweils mit **Pflicht-Begründung**, die dauerhaft sichtbar bleibt. Ausgezahlt wird nur bei **Einstimmigkeit**; die zweite, übereinstimmende Stimme schließt die Wette ab. Die **erste Stimme beendet sofort die Einsatzphase** (auch vor dem Einsatzschluss), damit niemand mit dem Wissen um eine abgegebene Stimme noch setzt. Auch eine Annullierung braucht beide Stimmen.
- **Streitfall:** Weichen die Stimmen ab, ist die Wette *strittig* – es wird nichts ausgezahlt, bis ein **Dev** die entscheidende Stimme abgibt (Dev-Panel → **Streitfälle**, mit Abzeichen im Menü). Bis dahin kann jede Seite ihre Stimme ändern; stimmen beide überein, löst sich der Streit von selbst. An einer Wette, in der ein Dev selbst Ersteller oder Schiedsrichter ist, muss ein anderer Dev entscheiden. Ohne Ergebnis 14 Tage nach dem Auswertungstermin (`AUTO_VOID_DAYS`) wird automatisch annulliert und erstattet – auch bei offenen Streitfällen.
- **Alte Wetten** von vor der Einführung des Verfahrens haben keinen Schiedsrichter; dort entscheidet der Wettersteller weiterhin allein.
- **Bearbeiten:** Die Beschreibung kann der Wettersteller ändern, solange die Wette offen ist; jede Änderung erscheint im öffentlichen Änderungsverlauf.
- **Kommentare** unter jeder Wette (Wettersteller und Teilnehmende mit gewählter Option markiert, eigene Kommentare löschbar, max. 6 pro Minute).
- **„Teilen“-Knopf** kopiert den Link zur Wette.
- **Live-Aktualisierung:** Übersicht, Wettseite und Lotterie prüfen alle 5 Sekunden, ob sich etwas geändert hat, und aktualisieren Topf, Quoten, Teilnehmende und Kommentare im Hintergrund – Eingaben bleiben dabei erhalten.

### Coin Exchange – Samantha Coin (SAM)
- Spielgeld in einen simulierten Coin investieren und jederzeit wieder verkaufen – zum aktuellen Kurs, ohne Gebühren.
- Live-Chart (1 Std. / 24 Std. / 7 Tage / 30 Tage / Alles), Depot (Wert, Einstand, Gewinn/Verlust), eigene Trades und Marktereignisse.
- **Kursmodell** (`src/coin/model.js`): stochastische Volatilität (ruhige und wilde Phasen), Renditen mit fetten Rändern (Student-t), häufige kleine und gelegentlich große Sprünge, seltene Pumps (+40 … +150 %) und Crashs (−80 … −99 %).
- **Kurs-Engine** (`src/coin/engine.js`): läuft im Server, neuer Kurs alle 5 Sekunden; Minutenkerzen (3 Tage) und Stundenkerzen (dauerhaft) in MongoDB. War der Server offline, wird die verpasste Zeit beim Start nachsimuliert, damit der Chart lückenlos bleibt.

### Lotterie
- Täglich eine Ziehung. Ein Los kostet 100 € (`LOTTERY_TICKET_EUR`), bis zu 10 Lose pro Kauf.
- Jedes Los hat eine Nummer; gezogen wird per kryptografischem Zufall, der Besitzer gewinnt den **gesamten Topf**.
- Ziehung am Folgetag, immer 1 Minute vor dem Start der nächsten Lotterie – standardmäßig Ziehung 19:59 Uhr, neue Runde 20:00 Uhr (`LOTTERY_TIME`).

### Trading Cards (TCG)
- Booster Pack mit 3 Karten (Standard 80 €, `TCG_PACK_EUR`), animiertes Öffnen – die seltenste Karte kommt zuletzt.
- **Sechs Seltenheiten** mit festen Chancen pro Karte: Crumpled 58,12 % · BFWler 28 % · Gold 11 % · Holo 2,5 % · Bockhaber 0,3 % · Glitch 0,08 %. Erst wird die Seltenheit gezogen, dann gleichverteilt eine Karte dieser Seltenheit.
- **Verkaufswerte:** 5 € / 20 € / 40 € / 150 € / 1.000 € / 3.000 €. Im Schnitt ist ein Pack weniger wert als sein Preis – es geht ums Sammeln.
- Sammlung mit Filter, fehlende Karten als „?“, Großansicht mit 3D-Neigung und Holo-/Gold-/Glitch-Effekten, Verkauf einzeln oder aller Duplikate.
- **Karten = Bilddateien** in `public/img/tcg` nach dem Schema `<name>[-<nr>]-<seltenheit>.webp` (z. B. `krisz-6-glitch.webp`). Neue Karte: Datei ablegen (auch als PNG möglich, `npm run webp` wandelt sie in WebP um) und Server neu starten.

### Konto, Bonus & Rangliste
- **Registrierung nur mit Einladungscode** (Format `XXXX-XXXX`, 30 Minuten gültig, für genau eine Person).
- **Nur für Mitglieder:** Ohne Anmeldung sind nur Startseite, Regeln, Impressum, Datenschutz sowie Anmelden/Registrieren sichtbar. Geteilte Wett-Links führen nach der Anmeldung direkt zur Wette.
- **Tagesbonus** nach Gesamtvermögen (verfügbar + offene Einsätze + Coins + Kartenwert): unter 500 € +150 €, unter 1.000 € +100 €, ab 1.000 € kein Bonus. Gutschrift beim ersten Seitenaufruf ab 07:45 Uhr (deutsche Zeit).
- **Mein Konto:** Guthaben, Einsätze, Coins, Karten, Gesamtvermögen, Bilanz, eigene Wetten, Kontoauszug, Passwort ändern.
- **Rangliste** nach Gesamtvermögen.
- **Support-Bot „Warren Buffett“:** Chat unten rechts (nur angemeldet), beantwortet ausschließlich Fragen zur Plattform auf Basis dessen, was jedes Mitglied selbst sehen kann (`src/support/knowledge.js`). Nutzt die Groq-API (`GROQ_API_KEY`; ohne Schlüssel ist der Chat ausgeblendet), max. 30 Nachrichten pro Stunde und Person.
- **IHK (Mini-Game, Prototyp – vorerst nur für Admins sichtbar):** Drei zufällige Quests zur Auswahl (`src/ihk/quests.js`), jede mit zufälliger Schwierigkeit (1–6, keine doppelt); welche Fähigkeit (FIA/FIS/BWL) gebraucht wird, muss man aus der Beschreibung erraten. Man schickt eine eigene Charakterkarte, die währenddessen gesperrt ist (nicht verkaufbar). Nach der Wartezeit wird die Quest abgespielt: Alle 600 ÷ Speed „Sekunden“ sammelt die Karte ihren Stat (×0,8–1,2, 10 % Krit ×2); geschafft, wenn das Ziel innerhalb von 180 Sekunden erreicht ist. Das Ergebnis wird beim Start auf dem Server ausgewürfelt. 6 Schwierigkeiten nach den Seltenheiten. Admin-Panel → „IHK: Limit & Lohn“: Quests pro Tag, Dauer (Minuten) und Lohn je Schwierigkeit. Kartenwerte stehen in `src/tcg/stats.js`; neue Karten können sie im Dateinamen tragen: `name-3-gold_36-39-21-12.png` (Speed-FIA-FIS-BWL).
- **Duell (Head-to-Head):** Im Profil „Herausfordern“ (`/duell/neu?gegen=<name>`): beide setzen denselben Betrag, ein Schiedsrichter entscheidet allein (3 % Provision, ganz an ihn). Gilt erst nach Zusage von Herausgefordertem und Schiedsrichter (48 Std., sonst Erstattung per Job); bis dahin nur für die drei sichtbar. Umsetzung als Wette mit Feld `duel` (`src/services/duelService.js`).
- **Black Market:** oben auf der Handelsseite, täglich 16:30–19:00 Uhr vier Karten (Gold 62 %, Holo 30 %, Bockhaber 6 %, Glitch 2 %), für alle dieselben und jede nur einmal; Preis 170 % des Verkaufswerts. Das Angebot wird beim ersten Aufruf nach der Öffnung gewürfelt (`src/tcg/blackMarket.js`).
- **Mehrfach-Konten und Sperren (nur Admin):** Jedes Gerät bekommt beim Anmelden eine signierte Kennung (Cookie `bfw.geraet`, zusätzlich im lokalen Speicher) und meldet einmal pro Sitzung einen Hash aus Browser-Merkmalen (`public/js/device.js`). Benutzen zwei Konten dasselbe Gerät, erscheint im Admin-Panel ein Hinweis samt Anmeldezeiten (Stufen: sicher = gleiche Kennung, wahrscheinlich = gleicher Fingerabdruck + gleiche IP, möglich = nur Fingerabdruck) und ein Abzeichen am Menüpunkt. Ein Ban (Dauer in Stunden, 0 = dauerhaft; im Admin-Panel oder im Profil über „Moderation“) gilt für das Konto und alle seine Geräte; die Ban-Liste im Admin-Panel hebt ihn wieder auf. Logik in `src/device/`, IP-Adressen nur als Hash.

### Sicherheit
- Alle Geldbewegungen laufen in **MongoDB-Transaktionen** (keine Doppelausgaben, kein negatives Guthaben, keine doppelten Auszahlungen) und landen im Kontoauszug.
- bcrypt-Passwort-Hashes, CSRF-Token in jedem Formular, Rate-Limits bei Anmeldung und Registrierung, Helmet-Sicherheitsheader (CSP), Sessions in MongoDB, HttpOnly-/SameSite-/Secure-Cookies.

**Seiten:** Wetten (Filter + Suche), Wettdetails, Neue Wette, Mein Konto, Rangliste, Coin Exchange, Lotterie, TCG, Regeln, Impressum, Datenschutz.

---

## 1. MongoDB Atlas einrichten

1. Auf [cloud.mongodb.com](https://cloud.mongodb.com) einen Cluster anlegen (der kostenlose M0 reicht).
2. **Database Access** → neuen Datenbanknutzer mit Passwort anlegen (Recht: readWrite).
3. **Network Access** → die **IP-Adresse des Servers** freigeben (zum Entwickeln vorübergehend auch die eigene).
4. **Connect → Drivers** → Connection-String kopieren und den Datenbanknamen (`/wettstube`) einsetzen:
   ```
   mongodb+srv://USER:PASSWORT@cluster0.xxxxx.mongodb.net/wettstube?retryWrites=true&w=majority
   ```
   Sonderzeichen im Passwort (`@ : / ?` usw.) müssen URL-kodiert werden.

Collections und Indizes werden beim ersten Start automatisch angelegt.

## 2. Lokal starten (optional)

```bash
npm install
cp .env.example .env      # ausfüllen: MONGODB_URI, SESSION_SECRET; NODE_ENV=development, COOKIE_SECURE=false
npm run dev               # http://localhost:3000
npm test                  # Tests (Abrechnung, Coin-Modell, Lotterie, TCG …)
```

## 3. Installation auf einem Server (Ubuntu/Debian)

### 3.1 Software
```bash
sudo apt update && sudo apt install -y nginx git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 3.2 Code auf den Server bringen
Per Git (`git clone … /var/www/wettstube`) oder den Ordner kopieren, z. B.:
```bash
scp -r wettstube user@SERVER_IP:/var/www/
```
(ohne `node_modules` und `.env`)

### 3.3 Konfiguration und Start
```bash
cd /var/www/wettstube
npm ci --omit=dev
cp .env.example .env
nano .env
```
Mindestens ausfüllen:
- `MONGODB_URI` – der Atlas-Connection-String
- `SESSION_SECRET` – z. B. erzeugen mit `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `COOKIE_SECURE=false`, **solange kein HTTPS eingerichtet ist** – danach `true`

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # den ausgegebenen Befehl ausführen, damit die App nach einem Neustart wieder läuft
pm2 logs wettstube # zeigt Fehler, z. B. wenn die Server-IP in Atlas nicht freigegeben ist
```

Den ersten Einladungscode erzeugt man direkt auf dem Server:
```bash
node scripts/create-code.js
```

### 3.4 Nginx + HTTPS
```bash
sudo cp deploy/nginx-wettstube.conf /etc/nginx/sites-available/wettstube
sudo nano /etc/nginx/sites-available/wettstube      # Domain eintragen
sudo ln -s /etc/nginx/sites-available/wettstube /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d deinedomain.de
```
Danach in der `.env` `COOKIE_SECURE=true` setzen und `pm2 restart wettstube` ausführen.

Firewall (falls aktiv): `sudo ufw allow 'Nginx Full' && sudo ufw allow OpenSSH`.

### 3.5 Aktualisieren
```bash
cd /var/www/wettstube
git pull            # oder neue Dateien hochladen
npm ci --omit=dev
pm2 restart wettstube
```

## Einstellungen (.env)

| Variable | Standard | Bedeutung |
|---|---|---|
| `MONGODB_URI` | – | Atlas-Connection-String (Pflicht) |
| `SESSION_SECRET` | – | langer Zufallswert (Pflicht, in Produktion mind. 32 Zeichen) |
| `APP_NAME` | BfW Holdings | Name der Seite |
| `START_BALANCE_EUR` | 1000 | Startguthaben |
| `MIN_STAKE_EUR` | 1 | Mindesteinsatz |
| `CREATOR_FEE_PERCENT` | 8 | Gesamtprovision in % vom Topf für Wettersteller und Schiedsrichter (je die Hälfte, für neue Wetten) |
| `AUTO_VOID_DAYS` | 14 | automatische Annullierung, wenn so lange nach dem Auswertungstermin kein Ergebnis vorliegt |
| `LOTTERY_TICKET_EUR` | 100 | Preis eines Lotterieloses |
| `LOTTERY_TIME` | 20:00 | Start der täglichen Lotterie (Ziehung 1 Minute vorher) |
| `TCG_PACK_EUR` | 80 | Preis eines Booster Packs |
| `GROQ_API_KEY` | – | Schlüssel für den Support-Bot (leer = Chat ausgeblendet) |
| `COOKIE_SECURE` | in Produktion true | ohne HTTPS auf `false` setzen |
| `TRUST_PROXY` | in Produktion 1 | Anzahl der Proxys vor der App (Nginx = 1) |
| `PORT` / `HOST` | 3000 / 127.0.0.1 | lauscht nur lokal, von außen über Nginx erreichbar |

## Vor dem Livegang

- **Impressum und Datenschutz:** In `views/impressum.ejs` und `views/datenschutz.ejs` stehen Platzhalter – mit den eigenen Angaben ausfüllen.
- **Backups:** Der kostenlose Atlas-Cluster (M0) hat keine automatischen Backups – regelmäßig mit `mongodump` sichern.

## Projektstruktur

```
server.js                   Start, Datenbankverbindung, sauberes Herunterfahren
src/config.js               Einstellungen aus der .env
src/app.js                  Express, Sicherheit, Sessions, Routen
src/lib/payout.js           Abrechnung (Totalisator)
src/services/               Wetten, Registrierung, Tagesbonus, Lotterie, Einladungscodes
src/coin/                   Samantha Coin: Kursmodell, Kurs-Engine, Handel
src/tcg/                    Trading Cards: Katalog und Chancen, Packs öffnen und verkaufen
src/support/                Support-Bot
src/models/                 MongoDB-Modelle
src/routes/                 Seiten und Aktionen
src/jobs.js                 Hintergrundaufgaben (automatische Annullierung, Lotterie-Ziehung)
views/                      EJS-Vorlagen
public/                     CSS, JavaScript, Bilder (Kartenbilder in public/img/tcg)
deploy/                     Nginx-Konfiguration
ecosystem.config.js         PM2-Konfiguration
```
