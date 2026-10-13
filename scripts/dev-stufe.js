/**
 * Ausbaustufe eines Grading-Shops setzen (#204, nur für die lokale Entwicklung) – zum Durchtesten der Stufen-Optik.
 *   npm run dev:stufe -- 3            Stufe 3 für admin
 *   npm run dev:stufe -- 1 anna       Stufe 1 für einen anderen Testspieler
 * Danach /grading neu laden. Werkzeuge werden zurückgesetzt, wenn sie für die Stufe noch nicht freigeschaltet sind.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
// dieselben Werte wie scripts/dev.js
Object.assign(process.env, {
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb://127.0.0.1:27027/wettstube-dev?replicaSet=dev',
  SESSION_SECRET: 'dev-secret-nur-lokal-dev-secret-nur-lokal',
  ADMIN_USERNAMES: 'admin',
  GROQ_API_KEY: '',
});

const mongoose = require(path.join(ROOT, 'node_modules', 'mongoose'));
const User = require(path.join(ROOT, 'src/models/User'));
const { GradingShop } = require(path.join(ROOT, 'src/models/Grading'));
const grading = require(path.join(ROOT, 'src/grading/gradingService'));

async function main() {
  const level = Number(process.argv[2]);
  const max = grading.LEVELS.length;
  if (!Number.isInteger(level) || level < 1 || level > max) throw new Error(`Stufe 1 bis ${max} angeben, z. B. npm run dev:stufe -- 3`);
  const username = (process.argv[3] || 'admin').toLowerCase();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
  const user = await User.findOne({ usernameLower: username }).select('_id username').lean();
  if (!user) throw new Error(`Spieler „${username}“ gibt es in der Dev-Datenbank nicht.`);
  const shop = await GradingShop.findById(user._id).lean();
  if (!shop) throw new Error(`${user.username} hat noch keinen Grading-Shop – erst im Browser anstellen lassen.`);
  const tools = (shop.tools || []).filter((k) => { const t = grading.TOOLS.find((x) => x.key === k); return t && t.level <= level; });
  await GradingShop.updateOne({ _id: user._id }, { $set: { level, ironing: null, tools } });
  console.log(`${user.username}: Stufe ${level} (${grading.LEVELS[level - 1].name})`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
