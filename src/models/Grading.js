const { Schema, model } = require('mongoose');
const { defectsSchema } = require('./condition');

// Preise je Baustein eines Spieler-Auftrags in Cent (#204) – beim Shop (null = Standardpreis) und eingefroren am Auftrag
const pricesSchema = new Schema({ base: { type: Number, default: null }, iron: { type: Number, default: null }, slab: { type: Number, default: null }, express: { type: Number, default: null }, review: { type: Number, default: null } }, { _id: false });
// Gebuchte Bausteine eines Spieler-Auftrags (#204): Reinigung ist immer dabei
const servicesSchema = new Schema({ iron: Boolean, slab: Boolean, express: Boolean, review: Boolean }, { _id: false });

// Grading-Shop eines Mitglieds (Mini-Game). _id = User-ID.
// Solange active = true, gibt es keinen Tagesbonus; kündigen geht erst ab lockedUntil.
const shopSchema = new Schema(
  {
    _id: Schema.Types.ObjectId,
    active: { type: Boolean, default: false },
    level: { type: Number, default: 1 }, // Ausbaustufe (bleibt nach einer Kündigung erhalten)
    hiredAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null }, // Vertragsbindung (10 Tage ab Annahme)
    jobsDone: { type: Number, default: 0 }, // Aufträge insgesamt
    earned: { type: Number, default: 0 }, // Lohn insgesamt in Cent
    name: { type: String, default: null }, // Name des Shops (#204), Pflicht vor dem ersten Auftrag
    slogan: { type: String, default: null }, // kurzer Werbespruch, steht in der Shop-Ansicht (gradingService.SHOP_SLOGAN_MAX)
    code: { type: String, default: null }, // Kürzel, z. B. "PSA" – steht auf den Slabs, eindeutig
    // Laufendes Bügeln einer eigenen Karte (#204): welches Exemplar, seit wann (Mindestzeit wie beim Putzen)
    ironing: { type: new Schema({ doc: Schema.Types.ObjectId, startedAt: Date }, { _id: false }), default: null },
    // Multiplayer (#204, Etappe B): Festpreise je Baustein für Spieler-Aufträge (Cent, null = Standardpreis aus den
    // Einstellungen; Bausteine in gradingService.SERVICES), ausgestellte Slabs (Vitrine), Reputation und Kennzahlen fürs Rating
    prices: { type: pricesSchema, default: () => ({}) },
    showcase: { type: [Schema.Types.ObjectId], default: [] },
    reputation: { type: Number, default: 0 },
    lastWorkedAt: { type: Date, default: null }, // letzter erledigter Auftrag – ab 7 Tagen Pause verfällt der Ruf (reputation.decayedReputation)
    repDecayedDays: { type: Number, default: 0 }, // so viele Tage Verfall sind in dieser Pause schon abgezogen
    stars: { type: new Schema({ sum: Number, n: Number }, { _id: false }), default: () => ({ sum: 0, n: 0 }) }, // Kundenbewertungen 1–5
    quality: { type: new Schema({ sum: Number, n: Number }, { _id: false }), default: () => ({ sum: 0, n: 0 }) }, // Arbeitsqualität 0–100 je Auftrag
    hits: { type: new Schema({ exact: Number, n: Number }, { _id: false }), default: () => ({ exact: 0, n: 0 }) }, // Treffsicherheit (alle benoteten Aufträge)
    playerJobsDone: { type: Number, default: 0 },
    // Kürzel ändern (#204): nach dem ersten Festlegen nur auf Anfrage, freigegeben von Admin oder Dev
    codeRequest: { type: new Schema({ code: String, at: Date }, { _id: false }), default: null },
    codeHistory: { type: [String], default: [] }, // frühere Kürzel (stehen noch auf älteren Slabs)
    tools: { type: [String], default: [] }, // gekaufte Werkzeug-Upgrades (#204, gradingService.TOOLS)
    reviewsSeenAt: { type: Date, default: null }, // Bewertungen bis hierhin gesehen (Badge am Handy auf dem Schreibtisch)
    tourSeenAt: { type: Date, default: null }, // Tour über den Schreibtisch gesehen oder übersprungen
    // letzte Auftragsannahme – dient als Sperre: gleichzeitige Annahmen schreiben dieses Dokument und laufen so
    // nacheinander (sonst ginge das Limit gleichzeitig angenommener Aufträge per Doppelklick über)
    takenAt: { type: Date, default: null },
  },
  { timestamps: true }
);
shopSchema.index({ active: 1 });
shopSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });

// Ein Auftrag: Karte eines (erfundenen) Kunden reinigen, bewerten und versiegeln.
// Flecken und Mängel werden beim Annehmen ausgewürfelt; die echte Note kennt nur der Server.
const jobSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true }, // "YYYY-MM-DD" (Bonustag, für das Tageslimit)
    level: { type: Number, required: true }, // Shop-Stufe beim Annehmen (bestimmt die Arbeitsschritte)
    card: { type: String, required: true }, // Karten-ID aus dem Katalog
    customer: { type: String, required: true },
    spots: { type: [new Schema({ side: String, x: Number, y: Number, r: Number, kind: String }, { _id: false })], default: [] },
    defects: { type: defectsSchema, default: () => ({}) }, // Kratzer, Ecken, Kanten, Knick (models/condition.js)
    grade: { type: Number, required: true }, // echte Note 1–10
    // offen = der aktive Auftrag (Werkbank, höchstens einer), angenommen = weitere angenommene im Hintergrund (bis MAX_ACCEPTED zusammen),
    // abgebrochen = NPC-Auftrag, der heute trotzdem zählt (#204)
    status: { type: String, enum: ['offen', 'angenommen', 'fertig', 'abgebrochen'], default: 'offen' },
    // Arbeitszeit für die Mindestzeiten (Putzen, Bügeln): nur die Zeit als aktiver Auftrag zählt, nicht das Warten unter
    // „Angenommen“ – activeAt = seit wann aktiv (null = im Hintergrund), workMs = schon gesammelte Zeit davor
    activeAt: { type: Date, default: null },
    workMs: { type: Number, default: 0 },
    guess: { type: Number, default: null }, // Note des Spielers
    clean: { type: Number, default: null }, // Sauberkeit beim Zurückschicken 0–100 %
    seal: { type: Number, default: null }, // Qualität der Versiegelung 0–100
    pay: { type: Number, default: 0 }, // Lohn in Cent
    foilFound: { type: Boolean, default: false }, // beim Versiegeln eine Folie gefunden
    iron: { type: new Schema({ smooth: Number, burns: Number }, { _id: false }), default: null }, // gebügelt (#204): geglättet in %, Brandflecken
    shopCode: { type: String, default: null }, // Kürzel des Shops beim Abschluss (steht auf dem Slab)
    // Spieler-Auftrag (#204, Etappe B): die Karte eines Mitglieds statt eines NPC-Kunden – Mängel und Note kommen aus
    // der echten Karte, das Ergebnis (Bügeln, Slab mit der Note des Shops) wirkt auf sie zurück
    source: { type: String, enum: ['npc', 'spieler'], default: 'npc' },
    order: { type: Schema.Types.ObjectId, ref: 'GradingOrder', default: null },
    cardDoc: { type: Schema.Types.ObjectId, ref: 'TcgCard', default: null }, // das Exemplar (Lage des Knicks wie auf der Karte)
    services: { type: servicesSchema, default: null }, // gebuchte Bausteine des Spieler-Auftrags (null = NPC: Schritte nach Stufe)
    // Posten beim Abschluss (#204, Kassenzettel auf dem Schreibtisch): NPC Lohn je Schritt + Zuschlag, Mitglieder die Bausteine
    parts: { type: new Schema({ clean: Number, iron: Number, grade: Number, slab: Number, base: Number, express: Number, review: Number, extra: Number }, { _id: false }), default: null },
    doneAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// Pro Mitglied höchstens ein offener Auftrag
jobSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { status: 'offen' } });
jobSchema.index({ user: 1, day: 1 });
jobSchema.index({ createdAt: -1 }); // Protokolle: alle Aufträge
jobSchema.index({ user: 1, createdAt: -1 });

// Spieler-Auftrag (#204, Etappe B): ein Mitglied reicht eine eigene Karte bei einem fremden Grading-Shop ein. Der Preis
// wird beim Einreichen eingezogen und liegt beim Auftrag, bis der Shop die Karte als Slab zurückschickt (dann bekommt
// der Shop ihn) oder der Auftrag abläuft bzw. storniert wird (dann zurück an den Kunden). Die Karte ist so lange gesperrt.
const orderSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ownerName: { type: String, required: true },
    shop: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // = GradingShop._id
    shopCode: { type: String, required: true },
    shopName: { type: String, default: null },
    doc: { type: Schema.Types.ObjectId, ref: 'TcgCard', required: true }, // das Exemplar
    card: { type: String, required: true }, // Karten-ID (Anzeige)
    price: { type: Number, required: true }, // Cent, Summe der Bausteine
    services: { type: servicesSchema, default: null }, // gebuchte Bausteine (fehlt bei älteren Aufträgen = Bügeln + Slab)
    priceParts: { type: pricesSchema, default: null }, // Preis je Baustein beim Einreichen
    status: { type: String, enum: ['wartet', 'in_arbeit', 'fertig', 'abgelaufen', 'storniert'], default: 'wartet' },
    expiresAt: { type: Date, required: true }, // bis dahin muss der Shop anfangen bzw. fertig werden
    startedAt: { type: Date, default: null },
    // erster Arbeitsbeginn: nur dann beginnt die Frist neu – nach einem Abbruch läuft sie weiter, sonst ließe sie sich
    // durch Abbrechen und neu Annehmen beliebig verlängern
    firstStartedAt: { type: Date, default: null },
    warnedAt: { type: Date, default: null }, // Shop wurde gewarnt, dass die Frist bald abläuft
    doneAt: { type: Date, default: null },
    job:{ type: Schema.Types.ObjectId, ref: 'GradingJob', default: null },
    // grade = Note des Shops; Zweitprüfung: before = Note auf dem Slab vorher, changed = neuer Slab, issuer = Kürzel vorher
    result: { type: new Schema({ grade: Number, clean: Number, seal: Number, iron: Number, before: Number, changed: Boolean, issuer: String }, { _id: false }), default: null },
    stars: { type: Number, default: null }, // Bewertung des Kunden 1–5
    tip: { type: Number, default: 0 }, // Trinkgeld des Kunden bei der Bewertung in Cent (orderService.TIP_MAX)
    tags: { type: [String], default: undefined }, // Schnell-Tags zur Bewertung (orderService.REVIEW_TAGS)
    ratedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
orderSchema.index({ shop: 1, status: 1, createdAt: 1 });
orderSchema.index({ owner: 1, status: 1, createdAt: -1 });
orderSchema.index({ status: 1, expiresAt: 1 });
orderSchema.index({ shop: 1, ratedAt: -1 }, { partialFilterExpression: { ratedAt: { $type: 'date' } } });
// Ein Exemplar kann nur in einem offenen Auftrag stecken
orderSchema.index({ doc: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['wartet', 'in_arbeit'] } } });

// Admin-Einstellungen (ein Dokument, _id "grading"). jobs = NPC-Aufträge pro Tag, playerJobs = Spieler-Aufträge pro Tag,
// servicePrice = Preisrahmen je Baustein der Spieler-Aufträge (Cent), orderDays/expressDays = Frist normal/Express,
// showcaseMax = Plätze in der Vitrine
const rangeSchema = new Schema({ min: Number, max: Number, def: Number }, { _id: false });
const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'grading' },
    open: Boolean,
    jobs: Number,
    playerJobs: Number,
    pay: { clean: Number, grade: Number, slab: Number, iron: Number },
    costs: [Number],
    premium: Number,
    servicePrice: { base: rangeSchema, iron: rangeSchema, slab: rangeSchema, express: rangeSchema, review: rangeSchema },
    orderDays: Number,
    expressDays: Number,
    showcaseMax: Number,
    toolCosts: { tuch: Number, schablone: Number, eisen: Number, uv: Number },
    updatedByName: String,
  },
  { timestamps: true }
);

module.exports = {
  GradingShop: model('GradingShop', shopSchema),
  GradingJob: model('GradingJob', jobSchema),
  GradingOrder: model('GradingOrder', orderSchema),
  GradingSettings: model('GradingSettings', settingsSchema),
};
