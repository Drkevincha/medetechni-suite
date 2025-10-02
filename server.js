// server.js – MedETechni Suite FULL (sin errores)
// Requisitos: npm i express multer qrcode pdfkit dayjs uuid
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const dayjs = require('dayjs');
const multer = require('multer');

// --- Google Cloud ---
const { Firestore } = require("@google-cloud/firestore");
const { Storage } = require("@google-cloud/storage");

// --- Config directorios (sobre-escribibles por vars de entorno) ---
const ROOT = __dirname;
const DATA_DIR   = process.env.DATA_DIR   || path.join(ROOT, 'data');
const CERTS_DIR  = process.env.CERTS_DIR  || path.join(ROOT, 'certs');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
[DATA_DIR, CERTS_DIR, UPLOAD_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const DB_FILE = path.join(DATA_DIR, 'records.json');
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([]));

// --- App base ---
const app = express();
const upload = multer({ dest: UPLOAD_DIR });
app.use(express.urlencoded({ extended: true }));  // forms
app.use('/certs', express.static(CERTS_DIR));
app.use(express.static(path.join(ROOT, 'public')));

const db = new Firestore();
const storage = new Storage();
const bucket = storage.bucket("medetechni-ensayos"); // crea este bucket en Google Cloud

// --- Utilidades ---
const loadDB = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const saveDB = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
const hashFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function brandHeader(doc, title){
  doc.fontSize(20).fillColor('#009EB5').text('MedETechni', {align:'left'});
  doc.moveDown(0.2);
  doc.fillColor('black').fontSize(16).text(title, {align:'left'});
  doc.moveDown(0.2);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width-doc.page.margins.right, doc.y)
    .strokeColor('#009EB5').lineWidth(1).stroke();
  doc.moveDown(0.4);
}
function placeQR(doc, qrPath, size=140, top=160){
  const x = doc.page.width - doc.page.margins.right - size;
  const y = top;
  try { doc.image(qrPath, x, y, { width: size }); } catch(e) {}
  doc.y = Math.max(doc.y, y + size + 20); // asegura no superposición
}

// Carga del consentimiento
function readConsent(){
  const p = path.join(ROOT, 'consent_text.txt');
  if (!fs.existsSync(p)) return '*** FALTA consent_text.txt: coloca aquí el texto íntegro del consentimiento. ***';
  return fs.readFileSync(p, 'utf8');
}
const CONSENT_TEXT = readConsent();

// --- HOME ---
app.get('/', (req,res)=>{
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- CONSENTIMIENTO ---
app.get('/consent', (req,res)=>{
  const consentHTML = CONSENT_TEXT
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\n/g,'<br/>');
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <link rel="stylesheet" href="/brand.css"/>
  <title>Consentimiento</title></head><body>
  <h1 style="color:#009EB5">Consentimiento informado</h1>
  <form method="POST" enctype="multipart/form-data" action="/consent/submit">
    <div>
      <label>Código de Paciente* <input name="patientCode" required/></label>
      <label>Nombre del Paciente <input name="patientName"/></label>
      <label>Investigador Responsable* <input name="investigator" required/></label>
      <label>Fecha* <input type="date" name="date" required/></label>
      <label>Lugar <input name="place" placeholder="Clínica / Ciudad"/></label>
    </div>
    <p><b>Texto del consentimiento (lectura):</b></p>
    <div style="height:260px;overflow:auto;border:1px solid #ddd;padding:10px;background:#f8fafc">${consentHTML}</div>
    <p><label><input type="checkbox" name="accept" value="yes" required/> He leído y acepto los términos</label></p>
    <div>
      <label>Firma del Paciente* <input type="file" name="sigPatient" accept="image/*" required/></label>
      <label>Firma del Investigador* <input type="file" name="sigInvestigator" accept="image/*" required/></label>
      <label>Firma del Testigo (opcional) <input type="file" name="sigWitness" accept="image/*"/></label>
      <label>Nombre del Testigo <input name="witnessName"/></label>
    </div>
    <button type="submit">Firmar y generar certificado</button>
  </form>
  <p><a href="/">← Inicio</a></p>
  </body></html>`);
});

app.post('/consent/submit', upload.fields([
  {name:'sigPatient',maxCount:1},
  {name:'sigInvestigator',maxCount:1},
  {name:'sigWitness',maxCount:1}
]), async (req,res)=>{
  const f = req.body;
  const id = uuidv4(); const createdAt = new Date().toISOString();
  const url = `${baseUrl(req)}/verify/${id}`;
  const qrPath = path.join(CERTS_DIR, `${id}.png`);
  await QRCode.toFile(qrPath, url);

  const pdfPath = path.join(CERTS_DIR, `${id}.pdf`);
  await new Promise((resolve,reject)=>{
    const doc = new PDFDocument({ size:'A4', margin:50 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    brandHeader(doc, 'Consentimiento informado – Certificado');
    doc.fontSize(10.5).text(`ID: ${id}`);
    doc.text(`Fecha/Hora: ${dayjs(createdAt).format('YYYY-MM-DD HH:mm:ss')}`);
    doc.text(`Paciente (código): ${f.patientCode}${f.patientName ? ' — ' + f.patientName : ''}`);
    doc.text(`Investigador: ${f.investigator}`);
    if (f.place) doc.text(`Lugar: ${f.place}`);
    doc.text(`Aceptación: ${f.accept==='yes'?'Sí':'No'}`);

    doc.moveDown(0.2);
    doc.text('Verificación pública:');
    doc.fillColor('#0b6').text(url, { link:url, underline:true });
    doc.fillColor('black');

    placeQR(doc, qrPath); // reserva espacio

    doc.moveDown(0.2);
    doc.fontSize(12).text('Texto del consentimiento', { underline:true });
    doc.moveDown(0.2);
    doc.fontSize(10).text(CONSENT_TEXT, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });

    // Firmas
    if (doc.y > doc.page.height - 260) doc.addPage();
    doc.moveDown(0.4);
    doc.fontSize(12).text('Firmas', { underline:true });
    const ySign = doc.y + 10;
    const x1 = doc.page.margins.left;
    const x2 = doc.page.width/2 + 10;

    const sigP = req.files?.sigPatient?.[0]?.path;
    const sigI = req.files?.sigInvestigator?.[0]?.path;
    const sigW = req.files?.sigWitness?.[0]?.path;

    if (sigP && fs.existsSync(sigP)) { try { doc.image(sigP, x1, ySign, { width: 200 }); } catch(e){} }
    if (sigI && fs.existsSync(sigI)) { try { doc.image(sigI, x2, ySign, { width: 200 }); } catch(e){} }

    doc.fontSize(10);
    doc.text('Paciente', x1+60, ySign+110);
    doc.text('Investigador', x2+60, ySign+110);

    let y2 = ySign + 140;
    if (sigW && fs.existsSync(sigW)) { try { doc.image(sigW, x1, y2, { width: 200 }); } catch(e){} }
    doc.text(`Testigo: ${f.witnessName || '-'}`, x1+60, y2+110);

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  const hash = hashFile(pdfPath);
const rec = { 
  id, 
  form: 'consent', 
  createdAt, 
  hash, 
  pdf: `/certs/${id}.pdf`, 
  qr: `/certs/${id}.png`, 
  patientCode: f.patientCode, 
  patientName: f.patientName || '' 
};

// Guardar local (como siempre)
const dbLocal = loadDB(); 
dbLocal.push(rec); 
saveDB(dbLocal);

// Guardar también en Firestore
await db.collection("ensayos_consent").add(rec);

// Subir PDF a Cloud Storage
await bucket.upload(pdfPath, {
  destination: `consent/${id}.pdf`
});

res.redirect(`/verify/${id}`);

});

// --- ELIGIBILITY ---
app.get('/eligibility', (req,res)=>{
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Filtro de criterios</title></head><body>
  <h1 style="color:#009EB5">Filtro de criterios de selección</h1>
  <form method="POST" enctype="multipart/form-data" action="/eligibility/submit">
    <label>Código Paciente* <input name="patientCode" required/></label>
    <label>Edad* <input type="number" name="edad" required/></label>
    <label>Sexo* <select name="sexo" required><option>Femenino</option><option>Masculino</option></select></label>
    <label>Peso (kg)* <input type="number" step="0.1" name="peso" required/></label>
    <label>Talla (cm)* <input type="number" step="0.1" name="talla" required/></label>
    <label>IMC* <input type="number" step="0.1" name="imc" required/></label>
    <h3>Inclusión</h3>
    ${['≥ 18 años','UV o UPD neuropático','San Elián < 20','Colonización crítica sin infección aguda','Úlcera 2–15 cm²','Consentimiento firmado']
      .map((t,i)=>`<label>${t}* <select name="inc${i+1}" required><option>Sí</option><option>No</option></select></label>`).join('')}
    <h3>Exclusión inmediata</h3>
    ${['ITB < 0.9','Extensión < 2 o > 15 cm²','100% tejido de granulación','Infección evidente','Antibiótico sistémico']
      .map((t,i)=>`<label>${t}* <select name="excI${i+1}" required><option>No</option><option>Sí</option></select></label>`).join('')}
    <h3>Exclusión (tres o más)</h3>
    ${['IMC ≥ 35','Oncológico último año','IRC (Cr > 2.0 mg/dL)','Corticoides ≥5 mg > 1 mes','HbA1c > 10','HTA ≥ 140/90']
      .map((t,i)=>`<label>${t}* <select name="excC${i+1}" required><option>No</option><option>Sí</option></select></label>`).join('')}
    <label>Investigador* <input name="investigador" required/></label>
    <label>Firma Investigador* <input type="file" name="sigInv" accept="image/*" required/></label>
    <label>Fecha* <input type="date" name="fecha" required/></label>
    <button type="submit">Evaluar y certificar</button>
  </form>
  <p><a href="/">← Inicio</a></p></body></html>`);
});

app.post('/eligibility/submit', upload.fields([{name:'sigInv'}]), async (req,res)=>{
  const f=req.body; const id=uuidv4(); const createdAt=new Date().toISOString();
  const url=`${baseUrl(req)}/verify/${id}`; const qrPath=path.join(CERTS_DIR,`${id}.png`); await QRCode.toFile(qrPath,url);
  const incOk=['inc1','inc2','inc3','inc4','inc5','inc6'].every(k=>f[k]==='Sí');
  const immBad=['excI1','excI2','excI3','excI4','excI5'].some(k=>f[k]==='Sí');
  let cnt=0; ['excC1','excC2','excC3','excC4','excC5','excC6'].forEach(k=>{ if(f[k]==='Sí') cnt++; });
  const eligible = incOk && !immBad && cnt < 3;
  const pdfPath=path.join(CERTS_DIR,`${id}.pdf`);
  await new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:50}); const stream=fs.createWriteStream(pdfPath); doc.pipe(stream);
    brandHeader(doc, 'Filtro de criterios – Certificado');
    doc.fontSize(10.5).text(`ID: ${id}`); doc.text(`Fecha/Hora: ${dayjs(createdAt).format('YYYY-MM-DD HH:mm:ss')}`);
    doc.text(`Paciente: ${f.patientCode}  |  Edad: ${f.edad}  |  Sexo: ${f.sexo}`);
    doc.text(`IMC: ${f.imc}  Peso: ${f.peso}kg  Talla: ${f.talla}cm`);
    doc.moveDown(0.2); doc.text(`Elegibilidad: ${eligible?'CUMPLE ✅':'NO CUMPLE ❌'}`);
    placeQR(doc, qrPath);
    const section=(t,arr)=>{ doc.moveDown(0.2); doc.fontSize(12).text(t,{underline:true}); doc.fontSize(10.5); arr.forEach(([k,v])=>doc.text(`${k}: ${v}`)); }
    section('Inclusión', [['≥18',f.inc1],['UV/UPD',f.inc2],['San Elián<20',f.inc3],['Colonización crítica',f.inc4],['2–15 cm²',f.inc5],['Consentimiento',f.inc6]]);
    section('Exclusión inmediata', [['ITB<0.9',f.excI1],['Extensión',f.excI2],['Granulación 100%',f.excI3],['Infección evidente',f.excI4],['Antibiótico sistémico',f.excI5]]);
    section('Exclusión (≥3)', [['IMC≥35',f.excC1],['Oncológico',f.excC2],['IRC',f.excC3],['Corticoides',f.excC4],['HbA1c>10',f.excC5],['HTA≥140/90',f.excC6]]);
    const sig=req.files?.sigInv?.[0]?.path; if(sig && fs.existsSync(sig)){ doc.moveDown(0.5); doc.text('Investigador: '+f.investigador); try{ doc.image(sig,{width:180}); }catch(e){} }
    doc.text('Fecha: '+f.fecha);
    doc.end(); stream.on('finish',resolve); stream.on('error',reject);
  });
  const hash=hashFile(pdfPath);
const rec={id,form:'eligibility',createdAt,hash,pdf:`/certs/${id}.pdf`,qr:`/certs/${id}.png`,patientCode:f.patientCode,eligible};

// Guardar local
const dbLocal = loadDB(); dbLocal.push(rec); saveDB(dbLocal);

// Guardar en Firestore
await db.collection("ensayos_eligibility").add(rec);

// Subir PDF a Cloud Storage
await bucket.upload(pdfPath, { destination: `eligibility/${id}.pdf` });

res.redirect(`/verify/${id}`);

});

// --- FICHA GENERAL DEL PACIENTE ---
app.get('/patient', (req,res)=>{
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Ficha general</title></head><body>
  <h1 style="color:#009EB5">Ficha general del paciente</h1>
  <form method="POST" enctype="multipart/form-data" action="/patient/submit">
    <label>ID Paciente* <input name="pid" required/></label>
    <label>Edad* <input type="number" name="edad" required/></label>
    <label>Sexo* <select name="sexo"><option>Femenino</option><option>Masculino</option></select></label>
    <label>Fecha* <input type="date" name="fecha" required/></label>
    <label>Peso (kg)* <input type="number" step="0.1" name="peso" required/></label>
    <label>Talla (cm)* <input type="number" step="0.1" name="talla" required/></label>
    <label>Estado civil* <select name="civil"><option>Soltero</option><option>Casado</option><option>Divorciado</option><option>Viudo</option></select></label>
    <label>Nivel educativo* <select name="educ"><option>Primaria</option><option>Secundaria</option><option>Técnico</option><option>Universitario</option></select></label>
    <h3>Antecedentes</h3>
    <label>Diabetes* <select name="diabetes"><option>No</option><option>Sí</option></select></label>
    <label>HTA* <select name="hta"><option>No</option><option>Sí</option></select></label>
    <label>IRC* <select name="irc"><option>No</option><option>Sí</option></select></label>
    <label>Obesidad* <select name="obesidad"><option>No</option><option>Sí</option></select></label>
    <label>Otros <input name="otros"/></label>
    <label>Duración DM <select name="dur_dm"><option>&lt;10</option><option>&gt;10</option></select></label>
    <label>Tipo DM <select name="tipo_dm"><option>Tipo 1</option><option>Tipo 2</option><option>Otros</option></select></label>
    <label>HbA1c (%) <input type="number" step="0.1" name="hba1c"/></label>
    <label>Tratamientos previos <input name="trat_prev"/></label>
    <label>ITB <input name="itb"/></label>
    <label>Corticoides <select name="corticoides"><option>No</option><option>Sí</option></select></label>
    <label>Creatinina (mg/dL) <input type="number" step="0.01" name="creat"/></label>
    <label>Presión arterial <input name="pa"/></label>
    <h3>Herida inicial</h3>
    <label>Diagnóstico* <select name="dx"><option>UPD</option><option>Úlcera Venosa</option></select></label>
    <label>Localización* <select name="loc"><option>Pie derecho</option><option>Pie izquierdo</option><option>Otra</option></select></label>
    <label>Tamaño inicial (cm²)* <input type="number" step="0.01" name="tam" required/></label>
    <label>Profundidad* <select name="prof"><option>Superficial</option><option>Profunda</option></select></label>
    <label>Fase de cicatrización* <select name="fase"><option>Epitelización</option><option>Granulación</option><option>Inflamatoria</option></select></label>
    <label>Saint Elián* <select name="se"><option>&lt;10</option><option>10–15</option><option>15–20</option></select></label>
    <label>Colonización crítica* <select name="cc"><option>No</option><option>Sí</option></select></label>
    <label>Foto de lesión* <input type="file" name="foto" accept="image/*" required/></label>
    <label>Investigadora* <input name="invest" required/></label>
    <label>Firma Investigadora* <input type="file" name="sig" accept="image/*" required/></label>
    <button type="submit">Guardar y certificar</button>
  </form>
  <p><a href="/">← Inicio</a></p></body></html>`);
});

app.post('/patient/submit', upload.fields([{name:'foto'},{name:'sig'}]), async (req,res)=>{
  const f=req.body; const id=uuidv4(); const createdAt=new Date().toISOString();
  const url=`${baseUrl(req)}/verify/${id}`; const qrPath=path.join(CERTS_DIR,`${id}.png`); await QRCode.toFile(qrPath,url);
  const pdfPath=path.join(CERTS_DIR,`${id}.pdf`);
  await new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:50}); const stream=fs.createWriteStream(pdfPath); doc.pipe(stream);
    brandHeader(doc, 'Ficha general del paciente – Certificado');
    doc.fontSize(10.5).text(`ID: ${id}`); doc.text(`Fecha/Hora: ${dayjs(createdAt).format('YYYY-MM-DD HH:mm:ss')}`);
    doc.text(`Paciente: ${f.pid} | Edad: ${f.edad} | Sexo: ${f.sexo} | PA: ${f.pa||'-'}`);
    doc.text(`Peso: ${f.peso}kg | Talla: ${f.talla}cm | HbA1c: ${f.hba1c||'-'}`);
    doc.text(`Antecedentes: DM:${f.diabetes} HTA:${f.hta} IRC:${f.irc} Obesidad:${f.obesidad} Otros:${f.otros||'-'}`);
    doc.text(`DM ${f.dur_dm||'-'} (${f.tipo_dm||'-'}) | ITB:${f.itb||'-'} | Corticoides:${f.corticoides} | Creatinina:${f.creat||'-'}`);
    placeQR(doc, qrPath);
    doc.fontSize(12).text('Herida inicial', {underline:true}); doc.fontSize(10.5);
    doc.text(`Dx:${f.dx} | Loc:${f.loc} | Tamaño:${f.tam} cm² | Prof:${f.prof} | Fase:${f.fase} | SE:${f.se} | Colonización:${f.cc}`);
    const foto=req.files?.foto?.[0]?.path; if(foto && fs.existsSync(foto)){ try{ doc.image(foto,{fit:[220,160]}); }catch(e){} }
    const sig=req.files?.sig?.[0]?.path; doc.moveDown(0.3); doc.text('Investigadora: '+(f.invest||'-')); if(sig && fs.existsSync(sig)){ try{ doc.image(sig,{width:180}); }catch(e){} }
    doc.text('Fecha: '+(f.fecha||'-'));
    doc.end(); stream.on('finish',resolve); stream.on('error',reject);
  });
 const hash=hashFile(pdfPath);
const rec={id,form:'patient',createdAt,hash,pdf:`/certs/${id}.pdf`,qr:`/certs/${id}.png`,patientCode:f.pid};

// Guardar local
const dbLocal = loadDB(); dbLocal.push(rec); saveDB(dbLocal);

// Guardar en Firestore
await db.collection("ensayos_patient").add(rec);

// Subir PDF a Cloud Storage
await bucket.upload(pdfPath, { destination: `patient/${id}.pdf` });

res.redirect(`/verify/${id}`);

});

// --- SF36 (antes y después) ---
function sf36Form(title, action){ return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${title}</title></head><body>
<h1 style="color:#009EB5">${title}</h1>
<form method="POST" action="${action}">
  <label>ID Paciente* <input name="pid" required/></label>
  <label>Fecha* <input type="date" name="fecha" required/></label>
  <label>Investigador* <input name="invest" required/></label>
  <p style="color:#555">Ingresa los puntajes por dominio (0–100).</p>
  ${['Función física','Rol físico','Dolor corporal','Salud general','Vitalidad','Función social','Rol emocional','Salud mental']
    .map((d,i)=>`<label>${d} (0–100) <input type="number" name="d${i+1}" min="0" max="100" step="1" required/></label>`).join('')}
  <button type="submit">Guardar y certificar</button>
</form>
<p><a href="/">← Inicio</a></p>
</body></html>`; }
app.get('/sf36-before', (req,res)=> res.send(sf36Form('SF‑36 – Antes de terapia','/sf36-before/submit')));
app.get('/sf36-after',  (req,res)=> res.send(sf36Form('SF‑36 – Después de terapia','/sf36-after/submit')));

async function sf36PDF(req,res,label){
  const f=req.body;
  const id=uuidv4();
  const createdAt=new Date().toISOString();
  const url=`${baseUrl(req)}/verify/${id}`;
  const qrPath=path.join(CERTS_DIR,`${id}.png`);

  // Generar QR
  await QRCode.toFile(qrPath,url);

  // Generar PDF
  const pdfPath=path.join(CERTS_DIR,`${id}.pdf`);
  await new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:50});
    const stream=fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    brandHeader(doc, `${label} – Certificado`);
    doc.fontSize(10.5).text(`ID: ${id}`);
    doc.text(`Paciente: ${f.pid} | Fecha: ${f.fecha}`);
    doc.text(`Investigador: ${f.invest}`);
    placeQR(doc, qrPath);

    const names=['Función física','Rol físico','Dolor corporal','Salud general','Vitalidad','Función social','Rol emocional','Salud mental'];
    names.forEach((n,i)=> doc.text(`${n}: ${f['d'+(i+1)]}`));

    let sum=0; for(let i=1;i<=8;i++){ sum+=parseFloat(f['d'+i]||0); }
    const avg=(sum/8).toFixed(1);
    doc.moveDown(0.2).text(`Puntaje promedio: ${avg}`);

    doc.end();
    stream.on('finish',()=>resolve(pdfPath));
    stream.on('error',reject);
  });

  // Guardar en DB y Storage
  const hash=hashFile(pdfPath);
  const formName = label.includes('Antes') ? 'sf36-before' : 'sf36-after';
  const rec={id,form:formName,createdAt,hash,pdf:`/certs/${id}.pdf`,qr:`/certs/${id}.png`,patientCode:req.body.pid};

  // Local
  const dbLocal = loadDB(); dbLocal.push(rec); saveDB(dbLocal);

  // Firestore
  await db.collection(`ensayos_${formName}`).add(rec);

  // Storage
  await bucket.upload(pdfPath, { destination: `${formName}/${id}.pdf` });

  res.redirect(`/verify/${rec.id}`);
}

app.post('/sf36-before/submit', (req,res)=> sf36PDF(req,res,'SF‑36 (Antes)'));
app.post('/sf36-after/submit',  (req,res)=> sf36PDF(req,res,'SF‑36 (Después)'));

// --- Lista de chequeo RAM (sesión) ---
app.get('/adverse', (req,res)=>{
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Lista RAM</title></head><body>
  <h1 style="color:#009EB5">Lista de chequeo – Reacciones adversas (RAM)</h1>
  <form method="POST" enctype="multipart/form-data" action="/adverse/submit">
    <label>ID Paciente* <input name="pid" required/></label>
    <label>Número de sesión* 
      <select name="sesion"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option><option>7</option><option>8</option><option>Otras</option></select>
    </label>
    <label>Fecha* <input type="date" name="fecha" required/></label>
    <label>Grupo* <select name="grupo"><option>Experimental (Virgilio Rays)</option><option>Control</option></select></label>
    <p>Marcar ítems completados:</p>
    ${['Evaluación detallada de la herida','Fotos antes/después','Inicio y duración registradas','UVC documentada','RAM y efectos secundarios registrados','Resultados de esterilización','Velocidad de cicatrización','Complicaciones metabólicas','Consideraciones éticas','Observaciones adicionales documentadas']
      .map((t,i)=>`<label><input type="checkbox" name="c${i+1}" value="Sí"/> ${t}</label>`).join('')}
    <label>Nombre investigadora* <input name="invest" required/></label>
    <label>Firma investigadora* <input type="file" name="sig" accept="image/*" required/></label>
    <button type="submit">Guardar y certificar</button>
  </form>
  <p><a href="/">← Inicio</a></p></body></html>`);
});
app.post('/adverse/submit', upload.fields([{name:'sig'}]), async (req,res)=>{
  const f=req.body; const id=uuidv4(); const createdAt=new Date().toISOString();
  const url=`${baseUrl(req)}/verify/${id}`; const qrPath=path.join(CERTS_DIR,`${id}.png`); await QRCode.toFile(qrPath,url);
  const pdfPath=path.join(CERTS_DIR,`${id}.pdf`);
  await new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:50}); const stream=fs.createWriteStream(pdfPath); doc.pipe(stream);
    brandHeader(doc, 'Lista de chequeo – RAM (Certificado)');
    doc.fontSize(10.5).text(`ID: ${id}`); doc.text(`Paciente: ${f.pid} | Sesión: ${f.sesion} | Grupo: ${f.grupo} | Fecha: ${f.fecha}`);
    placeQR(doc, qrPath);
    for(let i=1;i<=10;i++){ doc.text(`• ${i} ${f['c'+i]?'✔':'✖'}`); }
    const sig=req.files?.sig?.[0]?.path; doc.moveDown(0.2); doc.text('Investigadora: '+f.invest); if(sig && fs.existsSync(sig)){ try{ doc.image(sig,{width:180}); }catch(e){} }
    doc.end(); stream.on('finish',resolve); stream.on('error',reject);
  });
const hash=hashFile(pdfPath);
const rec={id,form:'adverse',createdAt,hash,pdf:`/certs/${id}.pdf`,qr:`/certs/${id}.png`,patientCode:f.pid};

// Guardar local
const dbLocal = loadDB(); dbLocal.push(rec); saveDB(dbLocal);

// Guardar en Firestore
await db.collection("ensayos_adverse").add(rec);

// Subir PDF a Cloud Storage
await bucket.upload(pdfPath, { destination: `adverse/${id}.pdf` });

res.redirect(`/verify/${id}`);

});

// --- Lista de chequeo – Eficacia (sesión) ---
app.get('/efficacy', (req,res)=>{
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Eficacia – Sesión</title></head><body>
  <h1 style="color:#009EB5">Lista de chequeo – Eficacia clínica (sesión)</h1>
  <form method="POST" enctype="multipart/form-data" action="/efficacy/submit">
    <label>ID Paciente* <input name="pid" required/></label>
    <label>Protocolo* <select name="proto"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option><option>7</option><option>8</option><option>9</option><option>Otros</option></select></label>
    <label>Fecha* <input type="date" name="fecha" required/></label>
    <label>Grupo* <select name="grupo"><option>Virgilio Rays</option><option>Control</option></select></label>
    <label>Dosis UVC (min)* <select name="dosis"><option>1</option><option>2</option><option>5</option></select></label>
    <label>Tamaño actual (cm²)* <input type="number" step="0.01" name="tam" required/></label>
    <label>Exudado* <select name="exu"><option>Ninguno</option><option>Seroso</option><option>Purulento</option></select></label>
    <label>Calidad del tejido* <select name="tej"><option>Granulación</option><option>Epitelización</option></select></label>
    <label>Foto de lesión* <input type="file" name="foto" accept="image/*" required/></label>
    <label>EVA Antes* <select name="eva1"><option>0</option><option>1–3</option><option>4–6</option><option>7–9</option><option>10</option></select></label>
    <label>EVA Después* <select name="eva2"><option>0</option><option>1–3</option><option>4–6</option><option>7–9</option><option>10</option></select></label>
    <label>Saint Elián* <select name="se"><option>&lt;10</option><option>10–15</option><option>15–20</option></select></label>
    <label>Reacciones locales <input name="rl" placeholder="Irritación, dolor, eritema, ..."/></label>
    <label>Reacciones sistémicas <input name="rs" placeholder="Fiebre, malestar, ..."/></label>
    <label>Gravedad* <select name="grav"><option>Ninguno</option><option>Leve</option><option>Moderado</option><option>Severo</option></select></label>
    <label>Tiempo de aparición <input name="tapp" placeholder="min/horas"/></label>
    <label>Intervenciones necesarias <input name="intv"/></label>
    <label>Adherencia* <select name="adh"><option>Cumplió</option><option>No cumplió</option></select></label>
    <label>Complicaciones* <select name="comp"><option>No</option><option>Sí</option></select></label>
    <label>Tipo de complicación <input name="tipo_comp" placeholder="Infección, reingreso, nueva lesión..."/></label>
    <label>Observaciones <textarea name="obs" rows="3"></textarea></label>
    <label>Investigadora* <input name="invest" required/></label>
    <label>Firma investigadora* <input type="file" name="sig" accept="image/*" required/></label>
    <button type="submit">Guardar y certificar</button>
  </form>
  <p><a href="/">← Inicio</a></p></body></html>`);
});
app.post('/efficacy/submit', upload.fields([{name:'foto'},{name:'sig'}]), async (req,res)=>{
  const f=req.body; const id=uuidv4(); const createdAt=new Date().toISOString();
  const url=`${baseUrl(req)}/verify/${id}`; const qrPath=path.join(CERTS_DIR,`${id}.png`); await QRCode.toFile(qrPath,url);
  const pdfPath=path.join(CERTS_DIR,`${id}.pdf`);
  await new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:50}); const stream=fs.createWriteStream(pdfPath); doc.pipe(stream);
    brandHeader(doc, 'Eficacia clínica – Sesión (Certificado)');
    doc.fontSize(10.5).text(`ID: ${id}`); doc.text(`Paciente: ${f.pid} | Protocolo:${f.proto} | Grupo:${f.grupo} | Fecha:${f.fecha}`);
    placeQR(doc, qrPath);
    doc.text(`Dosis UVC:${f.dosis}min | Tamaño:${f.tam}cm² | Exudado:${f.exu} | Tejido:${f.tej}`);
    doc.text(`EVA Antes:${f.eva1} → Después:${f.eva2} | Saint Elián:${f.se}`);
    doc.text(`RAM: Locales(${f.rl||'-'}) Sistémicas(${f.rs||'-'}) | Gravedad:${f.grav} | Tiempo:${f.tapp||'-'} | Intervenciones:${f.intv||'-'}`);
    doc.text(`Adherencia:${f.adh} | Complicaciones:${f.comp} | Tipo:${f.tipo_comp||'-'}`);
    doc.text('Observaciones:'); doc.text(f.obs||'-',{width:500});
    const foto=req.files?.foto?.[0]?.path; if(foto && fs.existsSync(foto)){ try{ doc.image(foto,{fit:[220,160]}); }catch(e){} }
    const sig=req.files?.sig?.[0]?.path; doc.moveDown(0.2); doc.text('Investigadora: '+f.invest); if(sig && fs.existsSync(sig)){ try{ doc.image(sig,{width:180}); }catch(e){} }
    doc.end(); stream.on('finish',resolve); stream.on('error',reject);
  });
const hash=hashFile(pdfPath);
const rec={id,form:'efficacy',createdAt,hash,pdf:`/certs/${id}.pdf`,qr:`/certs/${id}.png`,patientCode:f.pid};

// Guardar local
const dbLocal = loadDB(); dbLocal.push(rec); saveDB(dbLocal);

// Guardar en Firestore
await db.collection("ensayos_efficacy").add(rec);

// Subir PDF a Cloud Storage
await bucket.upload(pdfPath, { destination: `efficacy/${id}.pdf` });

res.redirect(`/verify/${id}`);

});

// --- VERIFICACIÓN ---
app.get('/verify/:id',(req,res)=>{
  const id=req.params.id; const db=loadDB(); const rec=db.find(r=>r.id===id);
  if(!rec) return res.status(404).send('<h1>No encontrado</h1>');
  const pdfPath=path.join(CERTS_DIR,`${id}.pdf`); if(!fs.existsSync(pdfPath)) return res.status(410).send('<h1>Archivo faltante</h1>');
  const current=hashFile(pdfPath); const valid=current===rec.hash;
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Verificación</title></head><body>
  <h1 style="color:#009EB5">Verificación de certificado</h1>
  <div>
    <p><b>Estado:</b> ${valid?'VÁLIDO ✅':'ALTERADO ❌'}</p>
    <p><b>ID:</b> ${rec.id}</p>
    <p><b>Formulario:</b> ${rec.form}</p>
    <p><b>Paciente:</b> ${rec.patientCode || '-'}</p>
    <p><b>Hash guardado:</b> <code>${rec.hash}</code></p>
    <p><b>Hash actual:</b> <code>${current}</code></p>
    <p><b>PDF:</b> <a target="_blank" href="${rec.pdf}">${rec.pdf}</a></p>
  </div>
  <p><a href="/">← Inicio</a></p>
  </body></html>`);
});

// --- LISTEN ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=> console.log(`✅ MedETechni Suite corriendo en http://localhost:${PORT}`));
