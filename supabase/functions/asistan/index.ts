// @ts-nocheck
// ═══════════════════════════════════════════════════════════════
//  ORİMAK Takip — Asistan (Notlar + Telefon Bildirimi) sunucu parçası
//  Supabase Edge Function. Kurulum: supabase/KURULUM.md
//
//  Bu dosyada GİZLİ ANAHTAR YOKTUR. Gereken her şey Supabase'in
//  kendi ortam değişkenlerinden (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
//  ve kilitli st_ayar tablosundan okunur.
// ═══════════════════════════════════════════════════════════════

const SB_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const KULLANICI_TBL = encodeURIComponent('kullanıcılar');
const SITE_URL = 'https://teknikservisorimak.github.io/orimak-takip/';
const TZ_SAAT = 3; // Türkiye sabit UTC+3

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ───────────── Veritabanı (PostgREST, service role) ─────────────
async function db(method, path, body, prefer) {
  const h = { apikey: SB_SERVICE, Authorization: 'Bearer ' + SB_SERVICE, 'Content-Type': 'application/json' };
  if (prefer) h.Prefer = prefer;
  const r = await fetch(SB_URL + '/rest/v1/' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error('DB ' + r.status + ': ' + t.slice(0, 300));
  return t ? JSON.parse(t) : null;
}
const sec = (tablo, sorgu) => db('GET', tablo + '?' + (sorgu || 'select=*'));
const ekle = (tablo, satir) => db('POST', tablo, satir, 'return=representation');
const guncelle = (tablo, sorgu, yama) => db('PATCH', tablo + '?' + sorgu, yama, 'return=representation');
const sil = (tablo, sorgu) => db('DELETE', tablo + '?' + sorgu);
const eq = (v) => 'eq.' + encodeURIComponent(String(v));

async function ayarAl(anahtar) {
  const r = await sec('st_ayar', 'select=deger&anahtar=' + eq(anahtar));
  return r && r.length ? r[0].deger : null;
}
async function ayarYaz(anahtar, deger) {
  await db('POST', 'st_ayar', { anahtar, deger, guncel: new Date().toISOString() }, 'resolution=merge-duplicates');
}

// ───────────── Yardımcılar ─────────────
const enc = new TextEncoder();
function b64u(buf) {
  const a = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uCoz(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function birlestir() {
  let n = 0;
  for (const p of arguments) n += p.length;
  const o = new Uint8Array(n);
  let k = 0;
  for (const p of arguments) { o.set(p, k); k += p.length; }
  return o;
}
function rastgele(n) {
  return b64u(crypto.getRandomValues(new Uint8Array(n)));
}
const kucuk = (s) => String(s || '').toLocaleLowerCase('tr-TR').trim();

// ───────────── Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) ─────────────
async function vapidAl() {
  let v = await ayarAl('vapid');
  if (v && v.genel && v.ozel) return v;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const genel = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
  const ozel = await crypto.subtle.exportKey('jwk', kp.privateKey);
  v = { genel, ozel };
  await ayarYaz('vapid', v);
  return v;
}

async function vapidBaslik(endpoint, vapid) {
  const u = new URL(endpoint);
  const bas = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const yuk = b64u(enc.encode(JSON.stringify({
    aud: u.protocol + '//' + u.host,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: SITE_URL,
  })));
  const key = await crypto.subtle.importKey('jwk', vapid.ozel, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const imza = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(bas + '.' + yuk));
  return 'vapid t=' + bas + '.' + yuk + '.' + b64u(imza) + ', k=' + vapid.genel;
}

async function hkdf(tuz, ikm, bilgi, uzunluk) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: tuz, info: bilgi }, k, uzunluk * 8));
}

async function sifrele(metin, p256dh, auth) {
  const uaGenel = b64uCoz(p256dh);
  const authGizli = b64uCoz(auth);
  const gecici = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asGenel = new Uint8Array(await crypto.subtle.exportKey('raw', gecici.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaGenel, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ortak = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, gecici.privateKey, 256));
  const ikm = await hkdf(authGizli, ortak, birlestir(enc.encode('WebPush: info\0'), uaGenel, asGenel), 32);
  const tuz = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(tuz, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(tuz, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const duz = birlestir(enc.encode(metin), new Uint8Array([2])); // 0x02 = son kayıt
  const sifreli = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, duz));
  const bas = new Uint8Array(21);
  bas.set(tuz, 0);
  new DataView(bas.buffer).setUint32(16, 4096);
  bas[20] = asGenel.length;
  return birlestir(bas, asGenel, sifreli);
}

// Tek aboneliğe gönderir. true = iletildi, false = abonelik ölü (silindi)
async function pushTek(abone, veri, vapid) {
  try {
    const govde = await sifrele(JSON.stringify(veri), abone.p256dh, abone.auth);
    const r = await fetch(abone.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidBaslik(abone.endpoint, vapid),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'high',
      },
      body: govde,
    });
    if (r.status === 404 || r.status === 410) {
      await sil('st_push', 'endpoint=' + eq(abone.endpoint));
      return false;
    }
    return r.ok;
  } catch (_e) {
    return false;
  }
}

// kullanıcı adlarına (küçük harf) bildirim gönderir → iletilen cihaz sayısı
async function pushGonder(kullanicilar, veri) {
  const hedef = Array.from(new Set((kullanicilar || []).map(kucuk).filter(Boolean)));
  if (!hedef.length) return 0;
  const tum = await sec('st_push', 'select=*');
  const liste = (tum || []).filter((a) => hedef.indexOf(kucuk(a.kullanici)) !== -1);
  if (!liste.length) return 0;
  const vapid = await vapidAl();
  const sonuc = await Promise.all(liste.map((a) => pushTek(a, veri, vapid)));
  return sonuc.filter(Boolean).length;
}

// ───────────── Kullanıcı / yetki ─────────────
async function kullaniciListesi() {
  const r = await sec(KULLANICI_TBL, 'select=kullanici_adi,rol&order=kullanici_adi.asc');
  return (r || []).map((x) => ({ ad: x.kullanici_adi, rol: x.rol }));
}

async function oturumCoz(token) {
  if (!token) return null;
  const o = await sec('st_oturum', 'select=*&token=' + eq(token));
  if (!o || !o.length) return null;
  const u = await sec(KULLANICI_TBL, 'select=kullanici_adi,rol&kullanici_adi=' + eq(o[0].kullanici));
  if (!u || !u.length) return null; // kullanıcı silinmiş
  return { ad: u[0].kullanici_adi, rol: u[0].rol, admin: u[0].rol === 'admin', tur: o[0].tur };
}

async function gorenlerAl() {
  const g = await ayarAl('not_gorenler');
  return Array.isArray(g) ? g : [];
}
const icinde = (liste, ad) => (liste || []).some((x) => kucuk(x) === kucuk(ad));

// Not yazma / Notlar sekmesini kullanma izni (admin her zaman; diğerleri admin seçerse)
async function izinliMi(k) {
  if (k.admin) return true;
  return icinde(await gorenlerAl(), k.ad);
}

// ───────────── Yazılan cümleden saat ve @kişi ayıklama ─────────────
const GUNLER = ['pazar', 'pazartesi', 'salı', 'çarşamba', 'perşembe', 'cuma', 'cumartesi'];
const AYLAR = ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'];

// Dönüş: ISO (UTC) ya da null. "simdi" test için dışarıdan verilebilir.
function zamanAyikla(metin, simdi) {
  const t = ' ' + kucuk(metin) + ' ';
  const now = simdi || new Date();
  // İstanbul duvar saati, UTC alanlarında tutulur
  const yerel = new Date(now.getTime() + TZ_SAAT * 3600000);
  let m;

  // "15 dk sonra", "2 saat sonra", "3 gün sonra"
  m = t.match(/(\d{1,3})\s*(dk|dak|dakika|saat|sa|gün|gun)\.?\s*(sonra|içinde|icinde)/);
  if (m) {
    const n = parseInt(m[1], 10);
    const b = m[2];
    const ms = (b === 'saat' || b === 'sa') ? n * 3600000 : (b === 'gün' || b === 'gun') ? n * 86400000 : n * 60000;
    return new Date(now.getTime() + ms).toISOString();
  }

  let gun = null; // {y, a, g}
  const gunEkle = (n) => {
    const d = new Date(Date.UTC(yerel.getUTCFullYear(), yerel.getUTCMonth(), yerel.getUTCDate() + n));
    return { y: d.getUTCFullYear(), a: d.getUTCMonth(), g: d.getUTCDate() };
  };
  if (/\s(öbür gün|öbürgün|yarından sonra)[\s.,!?]/.test(t)) gun = gunEkle(2);
  else if (/\syarın(a|ki)?[\s.,!?]/.test(t)) gun = gunEkle(1);
  else if (/\sbugün(e|kü)?[\s.,!?]/.test(t)) gun = gunEkle(0);
  else {
    for (let i = 0; i < 7 && !gun; i++) {
      // "cuma" → "cumartesi" ile karışmasın, "pazar" → "pazartesi" ile karışmasın
      const re = new RegExp('\\s' + GUNLER[i] + '(?!r?tesi)(ya|ye|a|e|ı|i|sı|si|ü|yı|yi)?(\\s+günü)?[\\s.,!?]');
      if (re.test(t)) {
        let fark = (i - yerel.getUTCDay() + 7) % 7;
        if (fark === 0) fark = 7;
        gun = gunEkle(fark);
      }
    }
  }
  if (!gun) {
    m = t.match(/\s(\d{1,2})[./](\d{1,2})[./](\d{4})[\s.,!?]/);
    if (m) gun = { y: +m[3], a: +m[2] - 1, g: +m[1] };
  }
  if (!gun) {
    m = t.match(new RegExp('\\s(\\d{1,2})\\s+(' + AYLAR.join('|') + ')'));
    if (m) {
      const a = AYLAR.indexOf(m[2]);
      let y = yerel.getUTCFullYear();
      if (Date.UTC(y, a, +m[1], 23, 59) < yerel.getTime()) y++;
      gun = { y, a, g: +m[1] };
    }
  }

  let saat = null, dk = 0;
  m = t.match(/\s(\d{1,2}):(\d{2})[\s.,!?'’]/);
  if (m) { saat = +m[1]; dk = +m[2]; }
  if (saat === null) {
    m = t.match(/saat\s+(\d{1,2})(?:[.:](\d{2}))?/);
    if (m) { saat = +m[1]; dk = m[2] ? +m[2] : 0; }
  }
  if (saat === null) {
    m = t.match(/\s(\d{1,2})(?:[.:](\d{2}))?\s?['’]?\s?(da|de|ta|te)[\s.,!?]/);
    if (m) { saat = +m[1]; dk = m[2] ? +m[2] : 0; }
  }
  if (saat === null) {
    if (/\ssabah/.test(t)) saat = 9;
    else if (/\s(öğlen|öğle)/.test(t)) saat = 12;
    else if (/\sakşam/.test(t)) saat = 18;
  } else if (saat < 12 && /\s(akşam|öğleden sonra)/.test(t)) {
    saat += 12; // "akşam 7'de" → 19:00
  } else if (saat >= 1 && saat <= 6 && !/\s(sabah|gece)/.test(t)) {
    saat += 12; // "saat 3'te" denince gündüz kastedilir → 15:00
  }
  if (saat !== null && (saat > 23 || dk > 59)) { saat = null; dk = 0; }

  if (!gun && saat === null) return null;
  if (!gun) {
    gun = gunEkle(0);
    const aday = Date.UTC(gun.y, gun.a, gun.g, saat, dk);
    if (aday <= yerel.getTime()) gun = gunEkle(1); // saat geçtiyse yarın
  }
  if (saat === null) saat = 9;
  const utc = Date.UTC(gun.y, gun.a, gun.g, saat, dk) - TZ_SAAT * 3600000;
  return new Date(utc).toISOString();
}

// "@ali @servis" → eşleşen kullanıcı adları + temizlenmiş metin
function kisiAyikla(metin, kullanicilar) {
  const bulunan = [];
  const temiz = String(metin).replace(/@([^\s@,;:!?]+)/g, (tam, ad) => {
    const a = kucuk(ad.replace(/[.'’]+$/, ''));
    if (a === 'herkes') {
      kullanicilar.forEach((k) => bulunan.push(k.ad));
      return '';
    }
    const k = kullanicilar.find((x) => kucuk(x.ad) === a) || kullanicilar.find((x) => kucuk(x.ad).indexOf(a) === 0);
    if (k) { bulunan.push(k.ad); return ''; }
    return tam;
  }).replace(/\s{2,}/g, ' ').trim();
  return { alicilar: Array.from(new Set(bulunan)), metin: temiz };
}

// ───────────── Komutlar: "servis plana 20.11 ABC Ambalaj ekle" ─────────────
const kk = (s) => { const o = String(s); const l = o.toLocaleLowerCase('tr-TR'); return l.length === o.length ? l : o.toLowerCase(); };
// Metindeki günü bulur → { gun:{y,a,g}, bas, uz }  (bas/uz: metin içindeki yeri)
function gunBul(metin, simdi) {
  const t = kk(metin);   // kırpma YOK → konumlar özgün metinle birebir aynı
  const now = simdi || new Date();
  const yerel = new Date(now.getTime() + TZ_SAAT * 3600000);
  const gunEkle = (n) => {
    const d = new Date(Date.UTC(yerel.getUTCFullYear(), yerel.getUTCMonth(), yerel.getUTCDate() + n));
    return { y: d.getUTCFullYear(), a: d.getUTCMonth(), g: d.getUTCDate() };
  };
  const yilSec = (a, g) => {
    let y = yerel.getUTCFullYear();
    if (Date.UTC(y, a, g, 23, 59) < yerel.getTime()) y++;
    return y;
  };
  const son = "(?:['’]?(?:de|da|te|ta|e|a|ye|ya|ne|na))?(?:\\s+(?:tarihinde|tarihine|tarihli|tarihi|günü|gününe))?";
  let m;
  const don = (gun) => ({ gun, bas: m.index, uz: m[0].length });
  if ((m = new RegExp('(?:öbür gün|öbürgün|yarından sonra)' + son).exec(t))) return don(gunEkle(2));
  if ((m = new RegExp('yarın(?:ki)?' + son + '(?=\\s|$|[.,!?])').exec(t))) return don(gunEkle(1));
  if ((m = new RegExp('bugün(?:kü)?' + son + '(?=\\s|$|[.,!?])').exec(t))) return don(gunEkle(0));
  if ((m = new RegExp('(\\d{1,2})[./](\\d{1,2})[./](\\d{4})' + son).exec(t))) {
    if (+m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return don({ y: +m[3], a: +m[2] - 1, g: +m[1] });
  }
  if ((m = new RegExp('(?<![\\d.:/])(\\d{1,2})[./](\\d{1,2})(?![\\d:/]|\\.\\d)' + son).exec(t))) {
    if (+m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return don({ y: yilSec(+m[2] - 1, +m[1]), a: +m[2] - 1, g: +m[1] });
  }
  if ((m = new RegExp('(\\d{1,2})\\s+(' + AYLAR.join('|') + ")(?:['’]?(?:da|de|ta|te|a|e))?(?:\\s+(\\d{4}))?" + '(?:\\s+(?:tarihinde|tarihine|günü))?').exec(t))) {
    const a = AYLAR.indexOf(m[2]);
    return don({ y: m[3] ? +m[3] : yilSec(a, +m[1]), a, g: +m[1] });
  }
  for (let i = 0; i < 7; i++) {
    m = new RegExp('(?<![a-zçğıöşü])' + GUNLER[i] + '(?!r?tesi)(?:ya|ye|a|e|ı|i|sı|si|yı|yi)?(?:\\s+günü)?(?=\\s|$|[.,!?])').exec(t);
    if (m) {
      let fark = (i - yerel.getUTCDay() + 7) % 7;
      if (fark === 0) fark = 7;
      return don(gunEkle(fark));
    }
  }
  return null;
}
const gunYaz = (g) => g.g + '.' + (g.a + 1) + '.' + g.y;   // sitedeki biçim: 6.11.2026

const DOLGU = new Set(['ekle', 'ekleyin', 'eklesin', 'ekler', 'eklensin', 'kaydet', 'kaydı', 'kayıt', 'yaz', 'aç', 'için', 'icin', 'firma',
  'firması', 'firmasını', 'firmasına', 'firmayı', 'firmaya', 'tarihinde', 'tarihine', 'tarihli', 'tarihi', 'tarih', 'günü', 'gününe', 'lütfen', 'bir', 'yeni', 'servis', 'servisi']);

// Komut değilse null. Komutsa { tur, veri } ya da { hata }.
function komutAyikla(metin, simdi) {
  const ham = String(metin || '').trim();
  const k = kucuk(ham);
  const planli = /^servis\s*plan\S*/.exec(k);
  const kisa = !planli && /^servise?\s/.test(k) && /\sekle\S*\s*[.!]?$/.test(k);
  if (!planli && !kisa) return null;
  let govde = planli ? ham.slice(planli[0].length) : ham.slice(k.indexOf(' ') + 1);
  // açıklama:  "... - BC410 arıza"  /  "... ; ..."  /  "... açıklama ..."
  let aciklama = '';
  const ay = /\s[-–—]\s|;\s*|\s(?:açıklama|aciklama|not)\s*:?\s+/.exec(kk(govde));
  if (ay) { aciklama = govde.slice(ay.index + ay[0].length).trim(); govde = govde.slice(0, ay.index); }
  let tarih = '';
  const g = gunBul(govde, simdi);
  if (g) { tarih = gunYaz(g.gun); govde = govde.slice(0, g.bas) + ' ' + govde.slice(g.bas + g.uz); }
  if (aciklama) { const g2 = !g && gunBul(aciklama, simdi); if (g2) tarih = gunYaz(g2.gun); }
  const firma = govde.split(/\s+/).filter((w) => w && !DOLGU.has(kucuk(w.replace(/[.,!?:;'’"]+$/g, '').replace(/^['’"]+/, '')))).join(' ')
    .replace(/^[\s,.:;-]+|[\s,:;-]+$/g, '').replace(/['’](?:yı|yi|yu|yü|ı|i|u|ü|a|e|ya|ye)$/i, '');
  if (!firma) return { hata: "Firma adı anlaşılamadı. Örnek: servis plana 20.11 ABC Ambalaj ekle" };
  const yerel = new Date((simdi || new Date()).getTime() + TZ_SAAT * 3600000);
  const talep = gunYaz({ y: yerel.getUTCFullYear(), a: yerel.getUTCMonth(), g: yerel.getUTCDate() });
  return { tur: 'servis_plan', veri: { firma: firma.slice(0, 200), tarih, talep, aciklama: aciklama.slice(0, 500) } };
}
function komutOzet(kmt) {
  const v = kmt.veri || {};
  return "Servis Plan'a eklenecek: " + v.firma + (v.tarih ? ' · ' + v.tarih : '') + (v.aciklama ? ' · ' + v.aciklama : '');
}
async function komutKaydet(k, kmt, kaynak, metin) {
  const r = await ekle('st_komut', { kullanici: k.ad, tur: kmt.tur, veri: kmt.veri, metin: String(metin).slice(0, 1000), kaynak: kaynak || 'site', durum: 'bekliyor' });
  return r[0];
}

function saatYaz(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + TZ_SAAT * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}
const kisalt = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

// ───────────── Not işlemleri ─────────────
async function notEkle(k, girdi, kaynak) {
  let metin = String(girdi.metin || '').trim();
  if (!metin) throw new Error('Not boş olamaz.');
  if (metin.length > 4000) metin = metin.slice(0, 4000);
  let alicilar = Array.isArray(girdi.alicilar) ? girdi.alicilar.map(String) : [];
  let hatirlat = girdi.hatirlat_at || null;

  if (girdi.ayristir) {
    const kl = await kullaniciListesi();
    const ks = kisiAyikla(metin, kl);
    if (ks.alicilar.length && k.admin && girdi.kisiSec) {   // kişi seçimi şimdilik kapalı (notlar kişisel)
      alicilar = alicilar.concat(ks.alicilar);
      if (ks.metin) metin = ks.metin;
    }
    if (!hatirlat) hatirlat = zamanAyikla(metin);
  }
  // Başkalarına gönderme yetkisi yalnızca admin'de
  if (!k.admin) alicilar = [];
  if (alicilar.length) {
    const kl = await kullaniciListesi();
    alicilar = Array.from(new Set(alicilar.map((a) => (kl.find((x) => kucuk(x.ad) === kucuk(a)) || {}).ad).filter(Boolean)));
    alicilar = alicilar.filter((a) => kucuk(a) !== kucuk(k.ad));
  }
  if (hatirlat) {
    const d = new Date(hatirlat);
    hatirlat = isNaN(d.getTime()) ? null : d.toISOString();
  }
  const satir = await ekle('st_notlar', {
    yazan: k.ad, metin, alicilar, hatirlat_at: hatirlat, hatirlatildi: false, tamam: false, kaynak: kaynak || 'site',
  });
  const n = satir[0];
  let iletilen = 0;
  if (alicilar.length) {
    iletilen = await pushGonder(alicilar, {
      baslik: '📝 ' + k.ad + ' not gönderdi',
      govde: kisalt(metin, 180) + (hatirlat ? '\n⏰ ' + saatYaz(hatirlat) : ''),
      id: n.id,
    });
  }
  return { not: n, iletilen };
}

function gorebilir(k, n) {
  return k.admin || kucuk(n.yazan) === kucuk(k.ad) || icinde(n.alicilar, k.ad);
}

async function notlarAl(k) {
  const tum = await sec('st_notlar', 'select=*&order=olusturma.desc&limit=600');
  return (tum || []).filter((n) => gorebilir(k, n));
}

async function hatirlatmaCalistir() {
  const simdi = new Date().toISOString();
  const liste = await sec('st_notlar', 'select=*&hatirlatildi=is.false&tamam=is.false&hatirlat_at=lte.' + encodeURIComponent(simdi) + '&order=hatirlat_at.asc&limit=50');
  let sayi = 0;
  for (const n of liste || []) {
    // önce işaretle → aynı hatırlatma iki kez gitmesin
    await guncelle('st_notlar', 'id=' + eq(n.id), { hatirlatildi: true });
    await pushGonder([n.yazan].concat(n.alicilar || []), {
      baslik: '⏰ Hatırlatma',
      govde: kisalt(n.metin, 200),
      id: n.id,
    });
    sayi++;
  }
  return sayi;
}

// ───────────── İstek yönlendirme ─────────────
function json(veri, durum) {
  return new Response(JSON.stringify(veri), { status: durum || 200, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}
function duz(metin, durum) {
  return new Response(metin, { status: durum || 200, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function oturumBilgisi(k) {
  const izin = await izinliMi(k);
  const notlar = await notlarAl(k);
  const vapid = await vapidAl();
  const o = {
    kullanici: k.ad, rol: k.rol, admin: k.admin,
    izin,                                  // not yazabilir / sekmeyi kullanabilir
    gorur: izin || notlar.length > 0,      // kendisine not gelmişse sekmeyi görür
    vapid: vapid.genel,
  };
  if (k.admin) {
    o.kullanicilar = await kullaniciListesi();
    o.gorenler = await gorenlerAl();
  }
  return o;
}

async function isle(req) {
  const url = new URL(req.url);

  // ── iPhone Kısayolu / hızlı bağlantı:  ?k=ANAHTAR&not=METİN ──
  if (url.searchParams.get('k')) {
    const k = await oturumCoz(url.searchParams.get('k'));
    if (!k || k.tur !== 'kisayol') return duz('✗ Anahtar geçersiz. Siteden yeni kısayol bağlantısı alın.', 401);
    if (!(await izinliMi(k))) return duz('✗ Not ekleme izniniz yok.', 403);
    let metin = url.searchParams.get('not') || '';
    if (!metin && req.method === 'POST') {
      // Kısayol "İstek Gövdesi" ile de gönderebilir: JSON {"not": "..."} / form not=... / düz metin
      let ham = '';
      try { ham = await req.text(); } catch (_e) { /* boş */ }
      metin = ham;
      try { const j = JSON.parse(ham); if (j && typeof j === 'object') metin = String(j.not || j.metin || ''); } catch (_e) {
        if (/^(not|metin)=/.test(ham)) metin = new URLSearchParams(ham).get('not') || new URLSearchParams(ham).get('metin') || '';
      }
    }
    if (!metin.trim()) return duz('✗ Not boş.', 400);
    const kmt = k.admin ? komutAyikla(metin) : null;
    if (kmt && kmt.hata) return duz('✗ ' + kmt.hata);
    if (kmt) {
      await komutKaydet(k, kmt, 'kisayol', metin);
      return duz('✓ ' + komutOzet(kmt) + '\n(Site açıldığında tabloya işlenir)');
    }
    const s = await notEkle(k, { metin, ayristir: true }, 'kisayol');
    let cevap = '✓ Not kaydedildi';
    if (s.not.hatirlat_at) cevap += '\n⏰ ' + saatYaz(s.not.hatirlat_at);
    if (s.not.alicilar && s.not.alicilar.length) cevap += '\n→ ' + s.not.alicilar.join(', ');
    return duz(cevap);
  }

  if (req.method !== 'POST') return json({ tamam: true, servis: 'orimak-asistan' });
  let g = {};
  try { g = await req.json(); } catch (_e) { return json({ hata: 'Geçersiz istek.' }, 400); }
  const islem = g.islem;

  // ── Zamanlayıcı (pg_cron her dakika çağırır) ──
  if (islem === 'cron') {
    const a = await ayarAl('cron_anahtar');
    if (!a || g.anahtar !== a) return json({ hata: 'yetkisiz' }, 401);
    return json({ tamam: true, gonderilen: await hatirlatmaCalistir() });
  }

  // ── Giriş: site şifresiyle oturum anahtarı al ──
  if (islem === 'giris') {
    const u = await sec(KULLANICI_TBL, 'select=kullanici_adi,rol&kullanici_adi=' + eq(g.kullanici || '') + '&sifre=' + eq(g.sifre || ''));
    if (!u || !u.length) return json({ hata: 'Kullanıcı adı veya şifre hatalı.' }, 401);
    const token = rastgele(32);
    await ekle('st_oturum', { token, kullanici: u[0].kullanici_adi, tur: 'site' });
    const k = { ad: u[0].kullanici_adi, rol: u[0].rol, admin: u[0].rol === 'admin', tur: 'site' };
    return json({ token, ...(await oturumBilgisi(k)) });
  }

  const k = await oturumCoz(g.token);
  if (!k || k.tur !== 'site') return json({ hata: 'oturum' }, 401);

  if (islem === 'oturum') return json(await oturumBilgisi(k));

  if (islem === 'notlar') return json({ notlar: await notlarAl(k) });

  // ── Komut kuyruğu: site açıkken sıradaki komutları alır, uygular, sonucu bildirir ──
  if (islem === 'komut_al') {
    if (!k.admin) return json({ komutlar: [] });
    const eski = new Date(Date.now() - 10 * 60000).toISOString();
    // yarıda kalmış (10 dk'dan eski "işleniyor") komutları kuyruğa geri al
    await guncelle('st_komut', 'durum=eq.isleniyor&kullanici=' + eq(k.ad) + '&alindi=lt.' + encodeURIComponent(eski), { durum: 'bekliyor' });
    // atomik: aynı komutu iki cihaz birden alamaz
    const al = await guncelle('st_komut', 'durum=eq.bekliyor&kullanici=' + eq(k.ad), { durum: 'isleniyor', alindi: new Date().toISOString() });
    return json({ komutlar: (al || []).sort((a, b) => a.id - b.id) });
  }
  if (islem === 'komut_sonuc') {
    if (!k.admin) return json({ hata: 'yetkisiz' }, 403);
    const yama = g.tamam ? { durum: 'uygulandi', uygulama: new Date().toISOString() } : { durum: 'bekliyor' };
    await guncelle('st_komut', 'id=' + eq(g.id) + '&kullanici=' + eq(k.ad) + '&durum=eq.isleniyor', yama);
    return json({ tamam: true });
  }

  if (islem === 'not_ekle') {
    if (!(await izinliMi(k))) return json({ hata: 'Not ekleme izniniz yok.' }, 403);
    if (g.ayristir && k.admin) {
      const kmt = komutAyikla(g.metin);
      if (kmt && kmt.hata) return json({ hata: kmt.hata }, 400);
      if (kmt) { const kk = await komutKaydet(k, kmt, 'site', g.metin); return json({ komut: kk, ozet: komutOzet(kmt) }); }
    }
    return json(await notEkle(k, g, 'site'));
  }

  if (islem === 'not_guncelle') {
    const r = await sec('st_notlar', 'select=*&id=' + eq(g.id));
    if (!r || !r.length || !gorebilir(k, r[0])) return json({ hata: 'Not bulunamadı.' }, 404);
    const n = r[0];
    const sahip = k.admin || kucuk(n.yazan) === kucuk(k.ad);
    const yama = {};
    if (typeof g.tamam === 'boolean') yama.tamam = g.tamam; // alıcı da "tamam" diyebilir
    if (sahip && typeof g.metin === 'string' && g.metin.trim()) yama.metin = g.metin.trim().slice(0, 4000);
    if (sahip && 'hatirlat_at' in g) {
      const d = g.hatirlat_at ? new Date(g.hatirlat_at) : null;
      yama.hatirlat_at = d && !isNaN(d.getTime()) ? d.toISOString() : null;
      yama.hatirlatildi = false;
    }
    if (!Object.keys(yama).length) return json({ not: n });
    const s = await guncelle('st_notlar', 'id=' + eq(n.id), yama);
    return json({ not: s[0] });
  }

  if (islem === 'not_sil') {
    const r = await sec('st_notlar', 'select=*&id=' + eq(g.id));
    if (!r || !r.length) return json({ tamam: true });
    if (!(k.admin || kucuk(r[0].yazan) === kucuk(k.ad))) return json({ hata: 'Bu notu yalnızca yazan kişi silebilir.' }, 403);
    await sil('st_notlar', 'id=' + eq(g.id));
    return json({ tamam: true });
  }

  // ── Telefon bildirimi aboneliği (her kullanıcı kendi cihazını kaydeder) ──
  if (islem === 'abone') {
    const a = g.abonelik || {};
    if (!a.endpoint || !a.keys || !a.keys.p256dh || !a.keys.auth) return json({ hata: 'Abonelik bilgisi eksik.' }, 400);
    if (!/^https:\/\//.test(a.endpoint)) return json({ hata: 'Geçersiz abonelik.' }, 400);
    await db('POST', 'st_push', {
      endpoint: a.endpoint, kullanici: k.ad, p256dh: a.keys.p256dh, auth: a.keys.auth,
      cihaz: String(g.cihaz || '').slice(0, 120), olusturma: new Date().toISOString(),
    }, 'resolution=merge-duplicates');
    return json({ tamam: true });
  }
  if (islem === 'abone_sil') {
    if (g.endpoint) await sil('st_push', 'endpoint=' + eq(g.endpoint) + '&kullanici=' + eq(k.ad));
    return json({ tamam: true });
  }
  if (islem === 'test_bildirim') {
    const n = await pushGonder([k.ad], { baslik: '🔔 ORİMAK Takip', govde: 'Bildirimler çalışıyor ✓' });
    return json({ tamam: true, iletilen: n });
  }

  // ── iPhone Kısayolu için kişisel bağlantı ──
  if (islem === 'kisayol') {
    if (!(await izinliMi(k))) return json({ hata: 'Not ekleme izniniz yok.' }, 403);
    if (g.yenile) await sil('st_oturum', 'tur=eq.kisayol&kullanici=' + eq(k.ad));
    let o = await sec('st_oturum', 'select=token&tur=eq.kisayol&kullanici=' + eq(k.ad));
    let anahtar = o && o.length ? o[0].token : null;
    if (!anahtar) {
      anahtar = rastgele(24);
      await ekle('st_oturum', { token: anahtar, kullanici: k.ad, tur: 'kisayol' });
    }
    return json({ anahtar, url: SB_URL + '/functions/v1/asistan?k=' + anahtar + '&not=' });
  }

  // ── Sadece admin: Notlar sekmesini kimler kullanabilir ──
  if (islem === 'ayar_kaydet') {
    if (!k.admin) return json({ hata: 'Bu ayarı yalnızca admin değiştirebilir.' }, 403);
    const liste = Array.isArray(g.gorenler) ? g.gorenler.map(String) : [];
    await ayarYaz('not_gorenler', liste);
    return json({ tamam: true, gorenler: liste });
  }

  return json({ hata: 'Bilinmeyen işlem.' }, 400);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    return await isle(req);
  } catch (e) {
    return json({ hata: 'Sunucu hatası: ' + (e && e.message ? e.message : String(e)) }, 500);
  }
});

// Test için (Deno'da etkisiz)
export { zamanAyikla, kisiAyikla, sifrele, vapidBaslik, komutAyikla, gunBul };
