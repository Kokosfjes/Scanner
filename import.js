import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const csvPath = resolve(args.find((a) => !a.startsWith("--")) ?? "data.csv");

const serviceAccount = JSON.parse(await readFile("./service-account.json", "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const raw = await readFile(csvPath, "utf8");
const rows = parseCSV(raw);
if (!rows.length) throw new Error("Tom CSV");

const header = rows.shift().map((h) => h.trim().toLowerCase());
const findCol = (...names) => {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
};
const iFornavn = findCol("fornavn", "firstname", "first name");
const iEtternavn = findCol("etternavn", "lastname", "last name");
const iNummer = findCol("nummer", "vis-id", "vis id", "visid", "id", "kode");

if (iFornavn < 0 || iEtternavn < 0 || iNummer < 0) {
  throw new Error(`CSV mangler kolonne. Fant: ${header.join(", ")}. Trenger fornavn/etternavn/nummer (eller vis-id, id).`);
}

const docs = [];
const skipped = [];
for (const [idx, row] of rows.entries()) {
  const fornavn = (row[iFornavn] ?? "").trim();
  const etternavn = (row[iEtternavn] ?? "").trim();
  const nummer = String(row[iNummer] ?? "").trim();

  if (!nummer) {
    skipped.push({ line: idx + 2, reason: "mangler nummer", fornavn, etternavn });
    continue;
  }
  if (!fornavn && !etternavn) {
    skipped.push({ line: idx + 2, reason: "mangler navn", nummer });
    continue;
  }

  docs.push({
    id: nummer,
    data: {
      name: `${fornavn} ${etternavn}`.trim(),
      firstName: fornavn,
      lastName: etternavn,
      used: false,
    },
  });
}

console.log(`Leste ${rows.length} rader → ${docs.length} dokumenter${skipped.length ? `, ${skipped.length} hoppet over` : ""}`);
if (skipped.length) console.log("Hoppet over:", skipped);

if (dryRun) {
  console.log("\nDRY RUN — de første 3 dokumentene som ville blitt skrevet:");
  for (const d of docs.slice(0, 3)) console.log(`  registered/${d.id}`, d.data);
  process.exit(0);
}

const BATCH_SIZE = 500;
let written = 0;
for (let i = 0; i < docs.length; i += BATCH_SIZE) {
  const batch = db.batch();
  const slice = docs.slice(i, i + BATCH_SIZE);
  for (const d of slice) {
    batch.set(db.collection("registered").doc(d.id), d.data, { merge: false });
  }
  await batch.commit();
  written += slice.length;
  console.log(`  Skrevet ${written}/${docs.length}`);
}

console.log(`✓ Ferdig. ${written} dokumenter skrevet til registered/`);
process.exit(0);

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = (text.split(/\r?\n/)[0] ?? "");
  const delim = firstLine.includes(";") && !firstLine.includes(",") ? ";" :
                firstLine.includes(";") && firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
  const out = [];
  let cur = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delim) { cur.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        cur.push(field);
        if (cur.length > 1 || cur[0] !== "") out.push(cur);
        cur = [];
        field = "";
      } else field += c;
    }
  }
  if (field !== "" || cur.length > 0) { cur.push(field); out.push(cur); }
  return out;
}
