# gflow — Google AI Flow CLI

Google hesabınızla (Gmail) **Google AI Flow** (`labs.google/fx/tools/flow`) üzerinden ücretsiz fotoğraf ve kredi-korumalı video üretimi yapan, her çıktıyı benzersiz ID ve prompt geçmişiyle SQLite katalogda tutan komut satırı aracı.

## Özellikler

- **Doğal Google Oturumu (Chrome CDP):** Bot korumasına takılmadan bilgisayardaki gerçek Chrome'u izole bir profille (`~/.gflow/chrome-profile`) açar.
- **Ücretsiz Fotoğraf Üretimi:** `nano-banana`, `nano-banana-pro`, `imagen-4` modelleriyle varsayılan 0 kredi üretim.
- **Kredi Güvenlik Kilidi:** Video üretimi (`veo-3.1-lite`, `veo-3.1-fast`, `veo-3.1-quality`, `omni-flash-1.2`) ve 0'dan fazla kredi harcayan tüm işlemler `--confirm-credits` olmadan **asla** çalışmaz; önce maliyet ve bakiye özetini döner (`exit code 2`).
- **Benzersiz ID & SQLite Katalog:** Her çıktı `img_0001`, `vid_0001` ID'siyle; prompt, negative prompt, model, oran, kalite, kredi, SHA-256, proje, etiket ve soy ağacı (`parentId`) bilgileriyle saklanır.
- **Remix & Animate:** Var olan bir `img_0001` ID'sinden yeni varyasyon (`gflow remix img_0001`) veya video (`gflow animate img_0001`) üretin.
- **AI Ajan Dostu:** Tüm komutlar `--json` destekler.

## Hızlı Başlangıç

```bash
# 1. Google hesabıyla giriş (izole Chrome açılır)
gflow auth login

# 2. Oturum ve kredi bakiyesi kontrolü
gflow auth status

# 3. Ücretsiz 2 adet 4:3 fotoğraf üret
gflow image -p "Minimalist studio photo of matte black coffee mug, soft light" -a 4:3 -n 2 --project marka

# 4. Geçmişi ve ID'leri gör
gflow list
gflow show img_0001
gflow search "coffee"

# 5. Bir fotoğrafı remix et (farklı oran + ek prompt)
gflow remix img_0001 -a 16:9 --append-prompt "warm morning sunlight"

# 6. Video maliyeti hesapla (üretim yapmaz)
gflow video -p "Slow cinematic pan over the coffee mug, rising steam" --first-frame img_0001 --dry-run

# 7. Kullanıcı onayından sonra video üret
gflow video -p "Slow cinematic pan over the coffee mug, rising steam" --first-frame img_0001 --confirm-credits
```

## Sorun Giderme

```bash
gflow doctor      # Chrome, CDP, SQLite ve oturum kontrolü
gflow calibrate   # Google Flow UI değişirse DOM/ARIA elementlerini yeniden tarar
```
