# Asistan (Notlar + Telefon Bildirimi) — Supabase kurulumu

Sitedeki **📝 Notlar** bölümü ve telefon bildirimleri, Supabase'in ücretsiz planında çalışan
küçük bir sunucu parçası kullanır. Kurulum **bir kez** yapılır, yaklaşık 5 dakika sürer.
Mevcut tablolara ve sitedeki verilere dokunmaz.

## 1) Tabloları ve zamanlayıcıyı kur

1. Supabase paneli → projen → sol menü **SQL Editor** → **New query**.
2. `supabase/kurulum.sql` dosyasının tamamını yapıştır → **Run**.
3. "Success" görmelisin. (Betik tekrar çalıştırılabilir; zarar vermez.)

Bu adım 4 kilitli tablo (`st_notlar`, `st_push`, `st_oturum`, `st_ayar`) ve hatırlatmalar için
dakikada bir çalışan zamanlayıcıyı kurar. Tablolar sitedeki açık anahtarla okunamaz.

## 2) Fonksiyonu yükle

1. Sol menü **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Fonksiyon adı: **`asistan`** (tam olarak böyle, küçük harf).
3. Editördeki örnek kodu sil, `supabase/functions/asistan/index.ts` dosyasının tamamını yapıştır.
4. **Deploy**.

## 3) JWT doğrulamasını kapat (iPhone kısayolu için)

1. **Edge Functions** → `asistan` → **Details** (ya da Settings).
2. **Verify JWT** (Enforce JWT verification) anahtarını **kapat** → Save.

Fonksiyon kimlik kontrolünü kendisi yapar (oturum anahtarı / kişisel kısayol anahtarı).
Bu ayar açık kalırsa site yine çalışır, yalnızca iPhone kısayolu çalışmaz.

## 4) Dene

1. Siteye admin olarak gir → sağ alttaki **📝** düğmesi → bir not yaz → **KAYDET**.
2. **🔔 Bildirimleri aç** → izin ver → deneme bildirimi gelmeli.
   - iPhone: önce siteyi Safari'den **Ana Ekrana Ekle**, ana ekrandaki simgeden gir, sonra aç.
3. Servis Takip → **📝 NOTLAR** sekmesi → **⚙ Kimler görsün** ile Notlar bölümünü kullanacak kişileri seç.
4. **📱 iPhone kısayolu** → ekrandaki adımlarla ana ekrana Hızlı Not düğmesi/widget'ı kur.

## Nasıl çalışır (kısa)

- Bildirim anahtarları (VAPID) ilk çalıştırmada fonksiyon tarafından üretilir ve kilitli `st_ayar`
  tablosunda saklanır. Depoda ya da sitede gizli anahtar yoktur.
- Not yazarken kişi seçilirse (yalnızca admin) o kişilerin kayıtlı cihazlarına bildirim gider.
- Hatırlatma saati gelen notlar için zamanlayıcı her dakika fonksiyonu çağırır.
- Metindeki `yarın 10:00`, `15 dk sonra`, `cuma 9'da`, `20.11.2026 saat 15.30` gibi ifadeler
  hatırlatmaya çevrilir; `@isim` (yalnızca admin) o kişiye gönderir, `@herkes` herkese.

## Sorun giderme

- **Sitede "Asistan sunucusu henüz kurulmamış"**: 2. adım eksik ya da fonksiyon adı `asistan` değil.
- **Bildirim gelmiyor**: alıcı kendi telefonunda **🔔 Bildirimleri aç**'a basmış olmalı.
  iPhone'da site ana ekrandan açılmış olmalı (iOS 16.4+).
- **Hatırlatma gelmiyor**: SQL Editor'da `select * from cron.job_run_details order by start_time desc limit 5;`
  ile zamanlayıcının çalıştığını kontrol et.
- **Kısayol "Anahtar geçersiz" diyor**: siteden **♻ Yenile** ile yeni bağlantı al.
